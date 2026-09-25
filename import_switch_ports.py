#!/usr/bin/env python3
"""
Import Switch Config Ports depuis un Excel -> Redis  (IPAM SIW v2)
================================================================================
Ajoute des switches et des ports SANS ÉCRASER l'existant :
  - un switch déjà présent sur le site (même nom) est réutilisé, pas recréé
  - un port déjà présent sur un switch (même numéro) est ignoré, jamais modifié

Format attendu (une ligne par serveur, colonnes) :
  Site | Hostname | Nom du Switch | Numero/Nom du port (1) | Numero/Nom du port (1)
       | Description | Nom du switch (2) | Numero/Nom du port | Description (2)

  - "Nom du Switch" / "Nom du switch (2)" : si la cellule est vide, on reprend
    le nom du switch de la ligne précédente (convention cellule fusionnée).
  - Les 2 colonnes "Numero/Nom du port (1)" créent 2 ports sur le 1er switch,
    tous deux -> Hostname, avec la Description.
  - Le port de la colonne "Numero/Nom du port" (switch 2) -> Hostname, sauf
    si le nom du switch 2 contient "SW" suivi d'un chiffre (ex. SW01, SW03) :
    dans ce cas le serveur du port est préfixé "ILO-" (switch de management).
  - "Site" est recherché parmi les sites existants (nom exact, ou avec les
    préfixes CREC/DSIBA/DOP/EBR/LBPE/LBPF ajoutés).

Usage :
  python3 import_switch_ports.py --xlsx ports.xlsx
                                  [--host 127.0.0.1] [--port 6379]
                                  [--password PWD] [--dry-run]
"""

import sys
import re
import argparse
from datetime import datetime, timezone

try:
    import openpyxl
except ImportError:
    sys.exit("Dépendance manquante : pip install openpyxl")

try:
    import redis as _redis_lib
except ImportError:
    sys.exit("Dépendance manquante : pip install redis")

NOW = datetime.now(timezone.utc).isoformat()
SITE_PREFIXES = ['', 'CREC ', 'DSIBA ', 'DOP ', 'EBR ', 'LBPE ', 'LBPF ']
SW_MGMT_RE = re.compile(r'SW\d', re.IGNORECASE)


def _find_col(header, *names):
    names_low = [n.strip().lower() for n in names]
    for i, h in enumerate(header):
        if h and str(h).strip().lower() in names_low:
            return i
    return None


def _cell(row, idx):
    if idx is None or idx >= len(row):
        return ''
    v = row[idx]
    return str(v).strip() if v is not None else ''


def resolve_site_id(sites_by_name, raw_name):
    """Cherche le site par nom exact, puis avec préfixes CREC/DSIBA/... """
    name_up = raw_name.strip().upper()
    if not name_up:
        return None
    if name_up in sites_by_name:
        return sites_by_name[name_up]
    for prefix in SITE_PREFIXES:
        candidate = f'{prefix}{name_up}'.strip()
        if candidate in sites_by_name:
            return sites_by_name[candidate]
    # Dernier recours : un site existant qui CONTIENT le nom cherché
    matches = [sid for nm, sid in sites_by_name.items() if name_up in nm]
    if len(matches) == 1:
        return matches[0]
    return None


def get_or_create_switch(r, site_id, name, switches_cache, dry_run):
    """Retourne l'id du switch (existant réutilisé, ou nouvellement créé)."""
    cache_key = (site_id, name.upper())
    if cache_key in switches_cache:
        return switches_cache[cache_key], False

    existing_ids = r.smembers(f'site:{site_id}:switches')
    for sid in existing_ids:
        sw = r.hgetall(f'switch:{sid}')
        if sw.get('name', '').strip().upper() == name.upper():
            switches_cache[cache_key] = sid
            return sid, False

    if dry_run:
        fake_id = f'DRYRUN-{len(switches_cache) + 1}'
        switches_cache[cache_key] = fake_id
        return fake_id, True

    new_id = str(r.incr('seq:switches'))
    r.hset(f'switch:{new_id}', mapping={
        'site_id': str(site_id), 'name': name.strip(), 'model': 'CISCO', 'ip': '', 'created_at': NOW,
    })
    r.sadd(f'site:{site_id}:switches', new_id)
    switches_cache[cache_key] = new_id
    return new_id, True


def set_port_if_absent(r, switch_id, port, server, description, dry_run):
    """N'écrit le port QUE s'il n'existe pas déjà (jamais d'écrasement)."""
    if str(switch_id).startswith('DRYRUN'):
        return True  # en dry-run on ne sait pas ce qui existe déjà pour un switch fictif
    existing = r.hexists(f'switch:{switch_id}:ports', port)
    if existing:
        return False
    if not dry_run:
        import json
        r.hset(f'switch:{switch_id}:ports', port,
               json.dumps({'server': server.strip(), 'description': description.strip()}))
    return True


def run_flat_import(r, rows, header, dry_run):
    """Format plat (1 ligne = 1 port) : Site | Switch | Model | Port | Server | Description.
    C'est le format produit par export_switch_ports.py — représente fidèlement
    n'importe quelle configuration (nombre de ports quelconque par switch)."""
    c_site  = _find_col(header, 'Site')
    c_sw    = _find_col(header, 'Switch', 'Nom du switch')
    c_model = _find_col(header, 'Model', 'Modèle')
    c_port  = _find_col(header, 'Port', 'Numéro/Nom du port')
    c_srv   = _find_col(header, 'Server', 'Serveur')
    c_desc  = _find_col(header, 'Description')

    if c_site is None or c_sw is None or c_port is None or c_srv is None:
        sys.exit(f"Colonnes 'Site' / 'Switch' / 'Port' / 'Server' introuvables. En-tête lu : {header}")

    site_ids = r.smembers('sites')
    sites_by_name = {}
    for sid in site_ids:
        nm = r.hget(f'site:{sid}', 'name')
        if nm:
            sites_by_name[nm.strip().upper()] = sid

    switches_cache = {}
    stats = {'switch_created': 0, 'switch_reused': 0, 'port_added': 0, 'port_skipped': 0, 'rows_skipped_no_site': 0}
    unresolved_sites = set()

    for row in rows[1:]:
        site_raw = _cell(row, c_site)
        sw_raw   = _cell(row, c_sw)
        port_raw = _cell(row, c_port)
        srv_raw  = _cell(row, c_srv)
        if not site_raw or not sw_raw or not port_raw or not srv_raw:
            continue
        model = _cell(row, c_model) or 'CISCO'
        desc  = _cell(row, c_desc)

        site_id = resolve_site_id(sites_by_name, site_raw)
        if not site_id:
            unresolved_sites.add(site_raw)
            stats['rows_skipped_no_site'] += 1
            continue

        sw_id, created = get_or_create_switch(r, site_id, sw_raw, switches_cache, dry_run)
        if model and not dry_run and not str(sw_id).startswith('DRYRUN'):
            r.hset(f'switch:{sw_id}', 'model', model)
        stats['switch_created' if created else 'switch_reused'] += 1
        added = set_port_if_absent(r, sw_id, port_raw, srv_raw, desc, dry_run)
        stats['port_added' if added else 'port_skipped'] += 1
        tag = 'AJOUTÉ' if added else 'ignoré (existe déjà)'
        print(f"  [{sw_raw}] {port_raw} -> {srv_raw} ({desc})  {tag}")

    return stats, unresolved_sites


def main():
    parser = argparse.ArgumentParser(description="Importe des ports de switch (Excel) dans Redis, sans écraser l'existant")
    parser.add_argument('--xlsx', required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=6379)
    parser.add_argument('--password', default=None)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    print(f"\nOuverture de {args.xlsx} ...")
    try:
        wb = openpyxl.load_workbook(args.xlsx, read_only=True, data_only=True)
    except FileNotFoundError:
        sys.exit(f"Fichier introuvable : {args.xlsx}")
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        sys.exit("Feuille vide.")
    header = rows[0]
    header_low = [str(h).strip().lower() if h else '' for h in header]

    try:
        r = _redis_lib.Redis(host=args.host, port=args.port, password=args.password, decode_responses=True)
        r.ping()
        print(f"Redis connecté : {args.host}:{args.port}")
    except Exception as e:
        sys.exit(f"Impossible de se connecter à Redis : {e}")
    if args.dry_run:
        print("Mode DRY-RUN -- aucune écriture Redis\n")

    # Détection du format : plat (Switch/Port/Server, 1 ligne = 1 port) vs
    # tableau (Nom du Switch / Numero/Nom du port (1) / ..., 1 ligne = 1 serveur).
    is_flat = 'switch' in header_low and 'port' in header_low and 'server' in header_low
    if is_flat:
        stats, unresolved_sites = run_flat_import(r, rows, header, args.dry_run)
        print("\n" + "=" * 55)
        print(f"Switches créés   : {stats['switch_created']}")
        print(f"Switches réutilisés (déjà existants) : {stats['switch_reused']}")
        print(f"Ports ajoutés    : {stats['port_added']}")
        print(f"Ports ignorés (déjà existants, non écrasés) : {stats['port_skipped']}")
        if stats['rows_skipped_no_site']:
            print(f"Lignes ignorées (site introuvable) : {stats['rows_skipped_no_site']}")
            print(f"  Sites non résolus : {sorted(unresolved_sites)}")
        if args.dry_run:
            print("\n(DRY-RUN -- rien n'a été écrit dans Redis)")
        print()
        return

    c_site   = _find_col(header, 'Site')
    c_host   = _find_col(header, 'Hostname')
    c_sw1    = _find_col(header, 'Nom du Switch', 'Nom du switch (1)')
    c_p1a    = 3  # 4e colonne : 1er port switch 1 (peu de libellés fiables, position fixe)
    c_p1b    = 4  # 5e colonne : 2e port switch 1
    c_desc1  = _find_col(header, 'Description')
    c_sw2    = _find_col(header, 'Nom du switch (2)', 'Nom du Switch (2)')
    c_p2     = 7  # 8e colonne : port switch 2
    c_desc2  = _find_col(header, 'Description(2)', 'Description (2)')

    if c_site is None or c_host is None:
        sys.exit(f"Colonnes 'Site' / 'Hostname' introuvables. En-tête lu : {header}")

    site_ids = r.smembers('sites')
    sites_by_name = {}
    for sid in site_ids:
        nm = r.hget(f'site:{sid}', 'name')
        if nm:
            sites_by_name[nm.strip().upper()] = sid

    switches_cache = {}
    last_sw1_by_site, last_sw2_by_site = {}, {}
    stats = {'switch_created': 0, 'switch_reused': 0, 'port_added': 0, 'port_skipped': 0,
              'rows_skipped_no_site': 0}
    unresolved_sites = set()

    for row in rows[1:]:
        site_raw = _cell(row, c_site)
        host_raw = _cell(row, c_host)
        if not site_raw or not host_raw:
            continue

        site_id = resolve_site_id(sites_by_name, site_raw)
        if not site_id:
            unresolved_sites.add(site_raw)
            stats['rows_skipped_no_site'] += 1
            continue

        sw1_raw = _cell(row, c_sw1)
        sw1_name = sw1_raw or last_sw1_by_site.get(site_id, '')
        if sw1_raw:
            last_sw1_by_site[site_id] = sw1_raw

        sw2_raw = _cell(row, c_sw2)
        sw2_name = sw2_raw or last_sw2_by_site.get(site_id, '')
        if sw2_raw:
            last_sw2_by_site[site_id] = sw2_raw

        desc1 = _cell(row, c_desc1)
        desc2 = _cell(row, c_desc2)
        p1a = _cell(row, c_p1a)
        p1b = _cell(row, c_p1b)
        p2  = _cell(row, c_p2)

        # ── Switch 1 : jusqu'à 2 ports, serveur = hostname ─────────────────────
        if sw1_name:
            sw1_id, created = get_or_create_switch(r, site_id, sw1_name, switches_cache, args.dry_run)
            stats['switch_created' if created else 'switch_reused'] += 1
            for p in (p1a, p1b):
                if not p:
                    continue
                added = set_port_if_absent(r, sw1_id, p, host_raw, desc1, args.dry_run)
                stats['port_added' if added else 'port_skipped'] += 1
                tag = 'AJOUTÉ' if added else 'ignoré (existe déjà)'
                print(f"  [{sw1_name}] {p} -> {host_raw} ({desc1})  {tag}")

        # ── Switch 2 : 1 port, serveur = hostname (ou ILO-hostname si SWxx) ────
        if sw2_name and p2:
            sw2_id, created = get_or_create_switch(r, site_id, sw2_name, switches_cache, args.dry_run)
            stats['switch_created' if created else 'switch_reused'] += 1
            server2 = f'ILO-{host_raw}' if SW_MGMT_RE.search(sw2_name) else host_raw
            added = set_port_if_absent(r, sw2_id, p2, server2, desc2, args.dry_run)
            stats['port_added' if added else 'port_skipped'] += 1
            tag = 'AJOUTÉ' if added else 'ignoré (existe déjà)'
            print(f"  [{sw2_name}] {p2} -> {server2} ({desc2})  {tag}")

    print("\n" + "=" * 55)
    print(f"Switches créés   : {stats['switch_created']}")
    print(f"Switches réutilisés (déjà existants) : {stats['switch_reused']}")
    print(f"Ports ajoutés    : {stats['port_added']}")
    print(f"Ports ignorés (déjà existants, non écrasés) : {stats['port_skipped']}")
    if stats['rows_skipped_no_site']:
        print(f"Lignes ignorées (site introuvable) : {stats['rows_skipped_no_site']}")
        print(f"  Sites non résolus : {sorted(unresolved_sites)}")
    if args.dry_run:
        print("\n(DRY-RUN -- rien n'a été écrit dans Redis)")
    print()


if __name__ == '__main__':
    main()
