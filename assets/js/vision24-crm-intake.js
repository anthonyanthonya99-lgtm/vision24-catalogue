/* ============================================================
 * Vision 24 · Pont formulaires → CRM
 * ============================================================
 * Envoie une copie de chaque demande de devis au CRM
 * (https://vision24.fr/api/submit.php), sans modifier l'envoi
 * email existant (FormSubmit) ni l'apparence des formulaires.
 *
 * Fiabilité :
 *  - corps envoyé en text/plain → pas de pré-contrôle CORS, donc
 *    fonctionne aussi depuis vision24.fun (autre domaine) ;
 *  - identifiant unique par demande → le serveur ignore les renvois ;
 *  - boîte d'envoi locale : si le CRM ne répond pas, la demande est
 *    renvoyée automatiquement à la prochaine visite (7 jours max).
 * Aucun secret n'est présent dans ce fichier.
 * ============================================================ */
(function () {
  'use strict';

  var API_URL = 'https://vision24.fr/api/submit.php';
  var OUTBOX_KEY = 'v24_crm_outbox';
  var MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  var MAX_ATTEMPTS = 10;
  var FORMSUBMIT_META = ['_subject', '_captcha', '_template', '_next', '_autoresponse', '_cc', '_url'];
  var inFlight = {};

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    var s = '';
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function sourceFromLocation() {
    var host = (location.hostname || '').toLowerCase();
    return host.indexOf('vision24.fun') !== -1 ? 'vision24.fun' : 'vision24.fr';
  }

  function pageHint() {
    var parts = location.pathname.split('/').filter(Boolean);
    return parts.slice(-2).join('/') || 'accueil';
  }

  function readOutbox() {
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch (e) { return []; }
  }
  function writeOutbox(list) {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); } catch (e) { /* stockage indisponible */ }
  }
  function removeFromOutbox(id) {
    writeOutbox(readOutbox().filter(function (e) { return e.id !== id; }));
  }

  /** Envoie une entrée. Résout true si c'est terminé (reçu ou refus définitif), false s'il faut réessayer. */
  function post(entry) {
    var body = JSON.stringify(entry.data);
    var opts = {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      keepalive: body.length < 60000,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: body
    };
    try {
      return fetch(API_URL, opts).then(function (res) {
        if (res.ok) return true;
        if (res.status === 400) return true;   // données inexploitables : inutile de réessayer
        return false;                          // 429 / 5xx : on réessaiera
      }).catch(function () { return false; });
    } catch (e) {
      // Navigateur ancien sans fetch : dernier recours, sans confirmation
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(API_URL, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) {
          return Promise.resolve(true);
        }
      } catch (_) {}
      return Promise.resolve(false);
    }
  }

  function flush() {
    var now = Date.now();
    readOutbox().forEach(function (entry) {
      if (inFlight[entry.id]) return;
      if (now - entry.createdAt > MAX_AGE_MS || entry.attempts >= MAX_ATTEMPTS) {
        removeFromOutbox(entry.id);
        return;
      }
      inFlight[entry.id] = true;
      entry.attempts = (entry.attempts || 0) + 1;
      writeOutbox(readOutbox().map(function (e) { return e.id === entry.id ? entry : e; }));
      post(entry).then(function (done) {
        delete inFlight[entry.id];
        if (done) removeFromOutbox(entry.id);
      });
    });
  }

  /** Point d'entrée public : envoie une demande au CRM. */
  function send(data) {
    var id = uuid();
    var payload = {};
    for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) payload[k] = data[k];
    payload.externalId = id;
    payload.source = payload.source || sourceFromLocation();
    payload.pageOrigine = payload.pageOrigine || pageHint();
    var list = readOutbox();
    list.push({ id: id, createdAt: Date.now(), attempts: 0, data: payload });
    writeOutbox(list);
    flush();
    return id;
  }

  function looksLikeDevisForm(form) {
    if (!form || form.id === 'checkoutForm') return false; // panier : envoi géré par submitOrder()
    var hasPrenom = !!form.querySelector('[name="prenom"], [name="firstname"], [name="first_name"]');
    var hasNom = !!form.querySelector('[name="nom"], [name="lastname"], [name="last_name"]');
    var hasContact = !!form.querySelector('[name="email"], [type="email"], [name="telephone"], [name="tel"]');
    return hasPrenom && hasNom && hasContact;
  }

  function formIsComplete(form) {
    if (form.checkValidity && !form.checkValidity()) return false;
    var required = form.querySelectorAll('[required]');
    for (var i = 0; i < required.length; i++) {
      var f = required[i];
      if (f.type === 'checkbox' || f.type === 'radio') {
        if (!form.querySelector('[name="' + f.name + '"]:checked')) return false;
      } else if (!String(f.value || '').trim()) {
        return false;
      }
    }
    return true;
  }

  function buildPayload(form) {
    var data = {};
    new FormData(form).forEach(function (v, k) {
      if (FORMSUBMIT_META.indexOf(k) !== -1) return;
      if (typeof v !== 'string') return; // fichiers : non transmis
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        if (!Array.isArray(data[k])) data[k] = [data[k]];
        data[k].push(v);
      } else {
        data[k] = v;
      }
    });
    return data;
  }

  function attach(form) {
    if (form.__v24Bound) return;
    form.__v24Bound = true;
    form.addEventListener('submit', function () {
      try {
        if (!formIsComplete(form)) return;
        var honey = form.querySelector('[name="_honey"]');
        if (honey && String(honey.value).trim()) return;
        send(buildPayload(form));
      } catch (e) {
        if (window.console) console.warn('[Vision24 CRM] envoi impossible', e);
      }
    }, { capture: true });
  }

  function scanForms() {
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) if (looksLikeDevisForm(forms[i])) attach(forms[i]);
  }

  window.Vision24CRM = { send: send, flush: flush };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scanForms(); flush(); });
  } else {
    scanForms();
    flush();
  }
  window.addEventListener('online', flush);
  if (window.MutationObserver) {
    new MutationObserver(scanForms).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
