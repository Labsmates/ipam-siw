// =============================================================================
// IPAM SIW — server-roles.js
// Catalogue partagé des rôles serveur — source unique utilisée par
// stats.js (classification/comptage par rôle) et site.js (liste déroulante
// Rôle de la fiche serveur, onglet Info contact).
// =============================================================================

export const WIN_ROLES = [
  { code: 'FS', label: 'Serveurs de Fichiers' },
  { code: 'AP', label: 'Serveurs Applicatifs' },
  { code: 'AR', label: 'Serveurs RUMBA' },
  { code: 'IS', label: "Serveurs d'Impression" },
  { code: 'TS', label: 'Serveurs de Rebond' },
  { code: 'FI', label: 'Serveurs Impression & Fichiers' },
  { code: 'ZN', label: 'Serveurs Fichier / APP' },
  { code: 'QN', label: 'Serveurs de Qualif' },
  { code: 'AT', label: 'Serveurs STEI' },
  { code: 'SS', label: 'Serveurs de Sauvegarde' },
  { code: 'LD', label: 'Serveurs Landesk' },
  { code: 'AF', label: 'Serveurs PROCEF' },
  { code: 'PR', label: 'Serveurs de PRA' },
  { code: 'AS',    label: 'Serveurs de Socle' },
  { code: 'AA',    label: 'Serveurs Rebond SRW' },
  { code: 'IDRAC', label: 'IDRAC / iLO' },
];

// Linux roles — CFT only (XG + XD fusionnés) ; SPHY compté séparément (Nutanix HDC)
export const LIN_ROLES = [
  { code: 'XG', label: 'Serveurs CFT' },
];

export const XMB_ROLE_LABEL = 'Serveurs XMB';
