// IPAM SIW — service worker minimal (installation en application web).
// Réseau uniquement : l'IPAM est une appli de données en direct avec
// authentification, aucun cache pour éviter d'afficher des écrans périmés.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
