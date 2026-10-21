/* =====================================================================
   RELAIS D'AGENDA : script à déployer sur Cloudflare Workers (gratuit)

   Rôle : les navigateurs n'ont pas le droit de lire directement l'adresse
   iCal secrète de Google Agenda. Ce petit relais, que VOUS contrôlez, lit
   l'agenda à la place du navigateur et le lui renvoie. Il ne garde rien en
   mémoire et n'accepte que des adresses d'agendas connus (liste ci-dessous).

   Il sert aussi les prix du marché (BE, FR, NL, DE-LU) pour un contrat dynamique (?prix=BE).

   Utilisation : dans l'appli, « Aide » > « Tutoriels » > « Connecter un agenda
   Google », partie 3 (ou le fichier LISEZMOI.txt). Après déploiement, l'adresse du
   relais se trouve sur la page du Worker, « Settings » > « Domains & Routes »,
   ligne workers.dev (forme https://mon-relais-agenda.xxxx.workers.dev, où xxxx est
   le nom propre à votre compte Cloudflare). Collez-la dans l'appli, onglet
   « Agenda », champ « Mon relais personnel ».
   ===================================================================== */

/* Sites d'agenda autorisés (un nom exact, ou un nom précédé d'un point pour inclure tous ses sous-domaines) */
const SITES_AUTORISES = [
  'calendar.google.com',
  'outlook.office365.com',
  'outlook.live.com',
  '.icloud.com',
  'calendar.proton.me',
];

/* Facultatif : adresses des sites autorisés à utiliser ce relais, par exemple
   ['https://mon-site.netlify.app']. Laissez vide pour autoriser tous les sites. */
const SITES_QUI_PEUVENT_UTILISER_LE_RELAIS = [];

const TAILLE_MAX = 5 * 1024 * 1024; // 5 Mo

function siteAutorise(hote) {
  return SITES_AUTORISES.some((s) => (s.startsWith('.') ? hote.endsWith(s) : hote === s));
}

export default {
  async fetch(request) {
    const origine = request.headers.get('Origin') || '';
    const restreint = SITES_QUI_PEUVENT_UTILISER_LE_RELAIS.length > 0;
    const cors = {
      'Access-Control-Allow-Origin': restreint ? (SITES_QUI_PEUVENT_UTILISER_LE_RELAIS.includes(origine) ? origine : 'null') : '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reponse = (corps, statut, type) =>
      new Response(corps, { status: statut, headers: { ...cors, 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return reponse('méthode non autorisée', 405);
    if (restreint && !SITES_QUI_PEUVENT_UTILISER_LE_RELAIS.includes(origine)) return reponse('site non autorisé', 403);

    const params = new URL(request.url).searchParams;
    /* prix du marché (contrat dynamique dans l'appli) : ?prix=BE (ou FR, NL, DE-LU)&debut=AAAA-MM-JJ&fin=AAAA-MM-JJ */
    if (params.get('prix')) {
      const jour = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
      const d = jour(params.get('debut')) || new Date().toISOString().slice(0, 10);
      const f = jour(params.get('fin')) || d;
      const zone = ['BE', 'FR', 'NL', 'DE-LU'].indexOf(params.get('prix')) >= 0 ? params.get('prix') : 'BE';
      let r;
      try {
        r = await fetch(`https://api.energy-charts.info/price?bzn=${zone}&start=${d}&end=${f}`);
      } catch (e) {
        return reponse('prix du marché injoignables', 502);
      }
      if (!r.ok) return reponse('prix du marché indisponibles (' + r.status + ')', 502);
      const t = await r.text();
      if (t.length > 300000) return reponse('réponse trop volumineuse', 413);
      return reponse(t, 200, 'application/json; charset=utf-8');
    }
    const cible = params.get('url');
    if (!cible) return reponse('relais-agenda ok'); // test de fonctionnement (bouton « Tester le relais »)

    let adresse;
    try {
      adresse = new URL(cible.trim().replace(/^webcals?:\/\//i, 'https://'));
    } catch (e) {
      return reponse('adresse non valide', 400);
    }
    if (adresse.protocol !== 'https:' || adresse.username || adresse.password) return reponse('seules les adresses https:// sont acceptées', 400);
    if (!siteAutorise(adresse.hostname)) return reponse('ce site d\'agenda n\'est pas dans la liste autorisée du relais (' + adresse.hostname + ')', 403);

    let source;
    try {
      source = await fetch(adresse.toString(), { headers: { Accept: 'text/calendar, */*;q=0.5' }, redirect: 'follow' });
    } catch (e) {
      return reponse('l\'agenda est injoignable', 502);
    }
    if (!source.ok) return reponse('l\'agenda a répondu par une erreur (' + source.status + ')', 502);
    const taille = Number(source.headers.get('Content-Length') || 0);
    if (taille > TAILLE_MAX) return reponse('agenda trop volumineux', 413);
    const texte = await source.text();
    if (texte.length > TAILLE_MAX) return reponse('agenda trop volumineux', 413);
    if (!texte.includes('BEGIN:VCALENDAR')) return reponse('cette adresse ne renvoie pas un calendrier iCal', 502);
    return reponse(texte, 200, 'text/calendar; charset=utf-8');
  },
};
