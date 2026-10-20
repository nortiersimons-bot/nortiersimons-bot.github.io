/* =====================================================================
   RELAIS BMW CARDATA : script à déployer sur Cloudflare Workers (gratuit)

   Rôle : lire la batterie (et le compteur) de votre voiture via l'API
   officielle « BMW CarData », avec VOTRE accord, et la renvoyer à l'appli.
   Un navigateur n'a pas le droit d'appeler BMW directement ; ce petit relais,
   que VOUS contrôlez, garde la connexion à votre compte BMW (jetons stockés
   dans votre espace Cloudflare, jamais dans l'appli) et ne répond qu'à
   quelqu'un qui connaît la clé RELAY_KEY.

   Mise en place complète, pas à pas : dans l'appli, « Aide » > « Tutoriels » >
   « Batterie automatique BMW CarData » (ou le fichier LISEZMOI.txt).
   Réglages à créer dans Cloudflare (sur la page du Worker) :
     - « Bindings » : un espace KV lié au script sous le nom   CARDATA
     - « Variables and Secrets » : un secret   CLIENT_ID   (l'identifiant client
       créé sur le portail BMW CarData, avec les accès « CarData API » et « CarData Stream »)
     - « Variables and Secrets » : un secret   RELAY_KEY   (un mot de passe long : à coller aussi dans l'appli)
     - conseillé : un déclencheur Cron   0 6 * * *   (renouvelle la connexion chaque jour, heure UTC)
     - facultatif : une variable   VIN   (si votre compte compte plusieurs véhicules)
   L'adresse du relais (« Settings » > « Domains & Routes », ligne workers.dev) affiche
   « relais-cardata ok » quand on l'ouvre dans un navigateur.

   À savoir : BMW limite à 50 lectures par jour ; le relais en garde une marge et
   mémorise la dernière réponse quelques minutes. BMW ne renvoie les données qu'au
   conducteur principal du véhicule.
   ===================================================================== */

const AUTH_BMW = 'https://customer.bmwgroup.com/gcdm/oauth';
const API_BMW = 'https://api-cardata.bmwgroup.com';
const PORTEE = 'authenticate_user openid cardata:api:read cardata:streaming:read';

/* données demandées à la voiture (jeux de repli si BMW refuse un identifiant inconnu pour ce modèle) */
const CLE_SOC = 'vehicle.powertrain.electric.battery.stateOfCharge.displayed';
const CLE_CIBLE = 'vehicle.powertrain.electric.battery.stateOfCharge.target';
const CLE_ETAT = 'vehicle.drivetrain.electricEngine.charging.status';
const CLE_COMPTEUR = 'vehicle.vehicle.travelledDistance';
const CLE_AUTONOMIE = 'vehicle.drivetrain.electricEngine.kombiRemainingElectricRange';
const JEUX = [
  [CLE_SOC, CLE_CIBLE, CLE_ETAT, CLE_COMPTEUR, CLE_AUTONOMIE, 'vehicle.body.chargingPort.status'],
  [CLE_SOC, CLE_ETAT, CLE_COMPTEUR, CLE_AUTONOMIE],
  [CLE_SOC, CLE_COMPTEUR],
  [CLE_SOC],
];

const MEMOIRE_S = 300;          // une réponse récente est resservie pendant 5 minutes
const MIN_ENTRE_LECTURES_S = 60; // même avec « fresh », jamais plus d'une lecture BMW par minute
const MAX_PAR_JOUR = 45;         // BMW coupe à 50 : on garde de la marge pour la mise en place

const entetesCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'x-relay-key, content-type',
  'Access-Control-Max-Age': '86400',
};
const json = (corps, statut = 200) =>
  new Response(JSON.stringify(corps), {
    status: statut,
    headers: { ...entetesCors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
const erreur = (message, statut = 400) => json({ ok: false, error: message }, statut);

/* comparaison de la clé sans fuite de temps */
function memeTexte(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

function base64url(octets) {
  let s = '';
  for (const o of octets) s += String.fromCharCode(o);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function pkce() {
  const hasard = crypto.getRandomValues(new Uint8Array(48));
  const verifier = base64url(hasard);
  const empreinte = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(empreinte) };
}

const lire = async (env, cle) => {
  const t = await env.CARDATA.get(cle);
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
};
const ecrire = (env, cle, valeur, ttl) =>
  env.CARDATA.put(cle, JSON.stringify(valeur), ttl ? { expirationTtl: Math.max(60, Math.ceil(ttl)) } : undefined);

async function postForm(url, champs) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(champs).toString(),
    signal: AbortSignal.timeout(15000),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* corps vide */ }
  return { statut: r.status, ok: r.ok, j: j || {} };
}

/* jetons : on en garde toujours un valable ; renouvellement automatique avec le jeton de rafraîchissement */
async function jetonValable(env, forcer) {
  const t = await lire(env, 'tokens');
  if (!t || !t.refresh || (t.refreshExp && Date.now() > t.refreshExp)) return null;
  if (!forcer && t.access && Date.now() < t.exp - 60000) return t.access;
  const r = await postForm(`${AUTH_BMW}/token`, {
    client_id: env.CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: t.refresh,
  });
  if (!r.ok || !r.j.access_token) {
    /* une autre requête (autre appareil, déclencheur Cron) a peut-être renouvelé les jetons au même moment :
       BMW n'accepte alors plus l'ancien jeton de rafraîchissement. On reprend les nouveaux avant de conclure. */
    const autre = await lire(env, 'tokens');
    if (autre && autre.refresh && autre.refresh !== t.refresh && autre.access && Date.now() < autre.exp - 60000) return autre.access;
    if (r.statut === 400 || r.statut === 401) await env.CARDATA.delete('tokens'); // connexion perdue : il faudra se reconnecter
    return null;
  }
  await memoriserJetons(env, r.j, t);
  return r.j.access_token;
}
async function memoriserJetons(env, j, ancien) {
  const maintenant = Date.now();
  await ecrire(env, 'tokens', {
    access: j.access_token,
    refresh: j.refresh_token || (ancien && ancien.refresh) || '',
    exp: maintenant + (Number(j.expires_in) || 3600) * 1000,
    refreshExp: maintenant + 14 * 24 * 3600 * 1000 - 3600 * 1000, // BMW : 2 semaines
    gcid: j.gcid || (ancien && ancien.gcid) || '',
  });
}

/* quota BMW : compteur du jour (UTC) */
const cleQuota = () => 'quota:' + new Date().toISOString().slice(0, 10);
async function quotaRestant(env) {
  const n = Number(await env.CARDATA.get(cleQuota())) || 0;
  return Math.max(0, MAX_PAR_JOUR - n);
}
async function compterAppel(env) {
  const n = (Number(await env.CARDATA.get(cleQuota())) || 0) + 1;
  await env.CARDATA.put(cleQuota(), String(n), { expirationTtl: 2 * 24 * 3600 });
}

async function apiBmw(env, jeton, chemin, options = {}) {
  await compterAppel(env);
  const r = await fetch(API_BMW + chemin, {
    method: options.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + jeton,
      'x-version': 'v1',
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* corps vide */ }
  return { statut: r.status, ok: r.ok, j: j || {} };
}

/* véhicule : variable VIN, sinon le véhicule principal du compte */
async function trouverVin(env, jeton) {
  if (env.VIN) return String(env.VIN).trim();
  const memo = await lire(env, 'vin');
  if (memo && memo.vin) return memo.vin;
  const r = await apiBmw(env, jeton, '/customers/vehicles/mappings');
  if (!r.ok) throw new Erreur(`BMW refuse la liste des véhicules (HTTP ${r.statut}). Le compte est-il bien abonné à CarData ?`, 502);
  const liste = Array.isArray(r.j) ? r.j : Array.isArray(r.j.mappings) ? r.j.mappings : [];
  const choisi = liste.find((v) => v && v.vin && String(v.mappingType || '').toUpperCase() === 'PRIMARY') || liste.find((v) => v && v.vin);
  if (!choisi) throw new Erreur('Aucun véhicule principal trouvé sur ce compte BMW (CarData ne renvoie que le conducteur principal).', 404);
  await ecrire(env, 'vin', { vin: choisi.vin });
  return choisi.vin;
}

/* conteneur : la « liste de courses » de données autorisée, créée une fois puis réutilisée */
async function trouverConteneur(env, jeton, renouveler) {
  if (!renouveler) {
    const memo = await lire(env, 'container');
    if (memo && memo.id) return memo.id;
  }
  /* un conteneur adapté existe déjà (créé par le relais ou à la main sur le portail BMW) : on le réutilise */
  const liste = await apiBmw(env, jeton, '/customers/containers');
  if (liste.ok) {
    const tous = Array.isArray(liste.j) ? liste.j : Array.isArray(liste.j.containers) ? liste.j.containers : [];
    const bon = tous.find((c) => c && (c.containerId || c.id) && String(c.state || 'ACTIVE').toUpperCase() !== 'DELETED'
      && (c.name === 'planificateur-recharge' || JSON.stringify(c.technicalDescriptors || c.descriptors || []).includes(CLE_SOC)));
    if (bon) {
      const id = bon.containerId || bon.id;
      await ecrire(env, 'container', { id, jeu: -1 });
      return id;
    }
  }
  for (let i = 0; i < JEUX.length; i++) {
    const r = await apiBmw(env, jeton, '/customers/containers', {
      method: 'POST',
      body: { name: 'planificateur-recharge', purpose: 'Batterie et compteur pour planifier la recharge', technicalDescriptors: JEUX[i] },
    });
    const id = r.j && (r.j.containerId || r.j.id);
    if (r.ok && id) {
      await ecrire(env, 'container', { id, jeu: i });
      return id;
    }
    if (r.statut === 401 || r.statut === 403 || r.statut === 429) throw new Erreur(`BMW refuse la création du conteneur (HTTP ${r.statut}).`, r.statut === 429 ? 429 : 502);
    /* autre refus (identifiant inconnu pour ce modèle ?) : on essaie le jeu suivant, plus court */
  }
  throw new Erreur('BMW a refusé tous les jeux de données (aucun identifiant accepté pour ce véhicule).', 502);
}

class Erreur extends Error {
  constructor(message, statut) { super(message); this.statut = statut || 500; }
}

const nombre = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const enKm = (d) => {
  const n = d && nombre(d.value);
  if (n == null) return null;
  return /mi/i.test(String(d.unit || '')) ? n * 1.609344 : n;
};
function etatCharge(d) {
  if (!d || d.value == null) return null;
  const v = String(d.value).toUpperCase().replace(/[^A-Z]/g, '');
  if (!v) return null;
  if (/NOCHARG|NOTCHARG|CHARGINGENDED|ENDED|FINISHED|COMPLETE|ERROR|FAULT|PAUSED|INACTIVE|IDLE|WAITING|DISCONNECT/.test(v)) return false;
  if (/CHARGINGACTIVE|^CHARGING$|ACTIVE|INPROGRESS|RUNNING/.test(v)) return true;
  return null;
}
function normaliser(donnees) {
  const T = donnees || {};
  const soc = T[CLE_SOC] ? nombre(T[CLE_SOC].value) : null;
  const cible = T[CLE_CIBLE] ? nombre(T[CLE_CIBLE].value) : null;
  const odo = enKm(T[CLE_COMPTEUR]);
  const autonomie = enKm(T[CLE_AUTONOMIE]);
  const instants = [CLE_SOC, CLE_COMPTEUR, CLE_ETAT]
    .map((k) => (T[k] && T[k].timestamp ? Date.parse(T[k].timestamp) : NaN))
    .filter((x) => Number.isFinite(x));
  return {
    soc: soc != null && soc >= 0 && soc <= 100 ? soc : null,
    target: cible != null && cible >= 0 && cible <= 100 ? cible : null,
    chg: etatCharge(T[CLE_ETAT]),
    odo: odo != null && odo >= 0 ? Math.round(odo) : null,
    range: autonomie != null && autonomie >= 0 ? Math.round(autonomie) : null,
    ts: instants.length ? Math.max(...instants) : null,
  };
}

async function lireVoiture(env, fresh) {
  const maintenant = Date.now();
  const memo = await lire(env, 'data');
  if (memo && memo.payload) {
    const age = (maintenant - memo.at) / 1000;
    if (age < (fresh ? MIN_ENTRE_LECTURES_S : MEMOIRE_S)) {
      return json({ ok: true, ...memo.payload, cached: true, quotaLeft: await quotaRestant(env) });
    }
  }
  if ((await quotaRestant(env)) < 2) {
    if (memo && memo.payload) return json({ ok: true, ...memo.payload, cached: true, stale: true, quotaLeft: 0 });
    return erreur('Quota BMW du jour atteint (50 lectures). Réessayez demain.', 429);
  }
  let jeton = await jetonValable(env, false);
  if (!jeton) return erreur('Compte BMW non connecté (ou connexion expirée) : utilisez « Connecter mon compte BMW » dans l\'appli.', 401);
  const vin = await trouverVin(env, jeton);
  let conteneur = await trouverConteneur(env, jeton, false);
  const appeler = () => apiBmw(env, jeton, `/customers/vehicles/${encodeURIComponent(vin)}/telematicData?containerId=${encodeURIComponent(conteneur)}`);
  let r = await appeler();
  if (r.statut === 401) { // jeton refusé malgré sa date : on le renouvelle une fois
    jeton = await jetonValable(env, true);
    if (!jeton) return erreur('Connexion BMW perdue : reconnectez votre compte dans l\'appli.', 401);
    r = await appeler();
  }
  if (r.statut === 404 || (r.statut === 400 && /container/i.test(JSON.stringify(r.j)))) { // conteneur disparu : on le recrée une fois
    conteneur = await trouverConteneur(env, jeton, true);
    r = await appeler();
  }
  if (r.statut === 429) return erreur('BMW limite le nombre de lectures (quota atteint). Réessayez plus tard.', 429);
  if (!r.ok) return erreur(`BMW n'a pas renvoyé les données (HTTP ${r.statut}).`, 502);
  const payload = normaliser(r.j.telematicData);
  payload.vin = '…' + String(vin).slice(-4);
  await ecrire(env, 'data', { at: maintenant, payload }, 3600);
  return json({ ok: true, ...payload, cached: false, quotaLeft: await quotaRestant(env) });
}

async function demarrerConnexion(env) {
  if (!env.CLIENT_ID) return erreur('CLIENT_ID manquant dans les réglages du relais.', 503);
  const { verifier, challenge } = await pkce();
  const r = await postForm(`${AUTH_BMW}/device/code`, {
    client_id: env.CLIENT_ID,
    response_type: 'device_code',
    scope: PORTEE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (!r.ok || !r.j.device_code) return erreur(`BMW refuse la demande de connexion (HTTP ${r.statut}) : vérifiez CLIENT_ID.`, 502);
  await ecrire(env, 'pending', { device_code: r.j.device_code, verifier }, Number(r.j.expires_in) || 600);
  return json({
    ok: true,
    user_code: r.j.user_code,
    verification_uri: r.j.verification_uri,
    verification_uri_complete: r.j.verification_uri_complete || null,
    expires_in: Number(r.j.expires_in) || 600,
    interval: Number(r.j.interval) || 5,
  });
}
async function sonderConnexion(env) {
  const p = await lire(env, 'pending');
  if (!p) return erreur('Aucune connexion en cours (le code a peut-être expiré). Relancez la connexion.', 400);
  const r = await postForm(`${AUTH_BMW}/token`, {
    client_id: env.CLIENT_ID,
    device_code: p.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    code_verifier: p.verifier,
  });
  if (r.ok && r.j.access_token) {
    await memoriserJetons(env, r.j, null);
    await env.CARDATA.delete('pending');
    await env.CARDATA.delete('container'); // nouveau compte : on recrée le conteneur
    await env.CARDATA.delete('vin');
    await env.CARDATA.delete('data');
    return json({ ok: true, connected: true });
  }
  const code = String(r.j.error || '');
  if (code === 'authorization_pending') return json({ ok: true, pending: true });
  if (code === 'slow_down') return json({ ok: true, pending: true, slow: true });
  await env.CARDATA.delete('pending');
  if (code === 'access_denied') return erreur('Accès refusé sur la page BMW.', 403);
  if (code === 'expired_token') return erreur('Le code a expiré. Relancez la connexion.', 400);
  return erreur(`BMW a refusé la connexion (${code || 'HTTP ' + r.statut}).`, 502);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: entetesCors });
    const chemin = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    if (chemin === '/') return new Response('relais-cardata ok', { headers: { ...entetesCors, 'Content-Type': 'text/plain; charset=utf-8' } });
    if (!env.CARDATA) return erreur('Espace KV « CARDATA » non lié au script.', 503);
    if (!env.RELAY_KEY) return erreur('RELAY_KEY manquant dans les réglages du relais.', 503);
    if (!memeTexte(request.headers.get('x-relay-key') || '', env.RELAY_KEY)) return erreur('Clé du relais incorrecte.', 401);
    try {
      if (chemin === '/status' && request.method === 'GET') {
        const t = await lire(env, 'tokens');
        const vin = await lire(env, 'vin');
        return json({
          ok: true,
          configured: !!env.CLIENT_ID,
          connected: !!(t && t.refresh && (!t.refreshExp || Date.now() < t.refreshExp)),
          refreshUntil: t ? t.refreshExp || null : null,
          vin: vin && vin.vin ? '…' + String(vin.vin).slice(-4) : null,
          quotaLeft: await quotaRestant(env),
        });
      }
      if (chemin === '/auth/start' && request.method === 'POST') return await demarrerConnexion(env);
      if (chemin === '/auth/poll' && request.method === 'POST') return await sonderConnexion(env);
      if (chemin === '/auth/logout' && request.method === 'POST') {
        for (const k of ['tokens', 'pending', 'container', 'vin', 'data']) await env.CARDATA.delete(k);
        return json({ ok: true });
      }
      if (chemin === '/data' && request.method === 'GET') {
        return await lireVoiture(env, new URL(request.url).searchParams.get('fresh') === '1');
      }
      return erreur('Adresse inconnue.', 404);
    } catch (e) {
      if (e instanceof Erreur) return erreur(e.message, e.statut);
      return erreur('Erreur du relais : ' + (e && e.message ? e.message : 'inconnue'), 500);
    }
  },

  /* déclencheur Cron (facultatif, une fois par jour) : renouvelle le jeton avant que les 2 semaines ne s'écoulent */
  async scheduled(event, env) {
    if (!env.CARDATA || !env.CLIENT_ID) return;
    await jetonValable(env, true);
  },
};
