(function () {
  // ─── CONFIG ──────────────────────────────────────────────────────────────────
  // Replace these two values once you have them from GA4 Admin.
  var MEASUREMENT_ID = 'G-4JP8R2ZLHK';

  // The phone number in the wa.me link as it currently exists on the landing page
  // (digits only, with country code, no + sign). If the page already has the full
  // wa.me href, this is just a fallback for the pre-fill — the script will rewrite
  // whatever href is already on the link.
  var WA_PHONE = '8617816534003'; // +86 17816534003

  // How long to wait (ms) for GA4 to return client_id before falling back.
  // GA4 is fast locally but can be slow on first load.
  var CLIENT_ID_TIMEOUT_MS = 1500;
  // ─────────────────────────────────────────────────────────────────────────────

  function getUTMParams() {
    var p = new URLSearchParams(window.location.search);
    return {
      source:   p.get('utm_source')   || '',
      medium:   p.get('utm_medium')   || '',
      campaign: p.get('utm_campaign') || '',
      content:  p.get('utm_content')  || '',
      term:     p.get('utm_term')     || '',
    };
  }

  // Generates a fallback client_id in the same format GA4 uses (random.timestamp)
  // so the REF tag is never blank even if gtag is slow.
  function fallbackClientId() {
    return Math.floor(Math.random() * 2147483647) + '.' + Math.floor(Date.now() / 1000);
  }

  function buildTaggedHref(originalHref, clientId, utm) {
    var url;
    try {
      url = new URL(originalHref);
    } catch (_) {
      // If the href isn't a full URL yet (e.g. relative), build from scratch
      url = new URL('https://wa.me/' + WA_PHONE);
    }

    var existingText = url.searchParams.get('text') || 'Hello, I would like to inquire about your products.';
    var src = [utm.source, utm.medium, utm.campaign].filter(Boolean).join('|') || 'direct';
    var tag = '\n[REF:' + clientId + '] [SRC:' + src + ']';

    url.searchParams.set('text', existingText + tag);
    return url.toString();
  }

  function buildTaggedMailto(originalHref, clientId, utm) {
    // Extract just the email address from the mailto: href
    // e.g. "mailto:jarvan@allybuilder.com" → "jarvan@allybuilder.com"
    var email = originalHref.replace(/^mailto:/i, '').split('?')[0];

    var src = [utm.source, utm.medium, utm.campaign].filter(Boolean).join('|') || 'direct';
    var subject = 'Product Inquiry';
    var body    = 'Hello, I would like to inquire about your products.'
                + '\n\n[REF:' + clientId + '] [SRC:' + src + ']';

    // Use encodeURIComponent (spaces → %20), NOT URLSearchParams (spaces → +)
    // mailto: links require %20 — email clients do not decode + as a space
    return 'mailto:' + email
      + '?subject=' + encodeURIComponent(subject)
      + '&body='    + encodeURIComponent(body);
  }

  function patchLink(link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      var originalHref = link.href;
      var utm = getUTMParams();
      var isMailto = originalHref.indexOf('mailto:') === 0;

      // Fire a GA4 event for whichever channel the visitor clicked
      if (typeof gtag === 'function') {
        gtag('event', isMailto ? 'email_click' : 'whatsapp_click', {
          utm_source:   utm.source,
          utm_medium:   utm.medium,
          utm_campaign: utm.campaign,
        });
      }

      var done = false;
      function navigate(clientId) {
        if (done) return;
        done = true;
        window.location.href = isMailto
          ? buildTaggedMailto(originalHref, clientId, utm)
          : buildTaggedHref(originalHref, clientId, utm);
      }

      // Timeout so the user is never stuck if GA4 is slow
      var timer = setTimeout(function () {
        navigate(fallbackClientId());
      }, CLIENT_ID_TIMEOUT_MS);

      if (typeof gtag === 'function') {
        try {
          gtag('get', MEASUREMENT_ID, 'client_id', function (clientId) {
            clearTimeout(timer);
            navigate(clientId || fallbackClientId());
          });
        } catch (_) {
          clearTimeout(timer);
          navigate(fallbackClientId());
        }
      } else {
        clearTimeout(timer);
        navigate(fallbackClientId());
      }
    });
  }

  function patchAllLinks() {
    var links = document.querySelectorAll(
      'a[href*="wa.me"], a[href*="api.whatsapp.com"], a[href^="mailto:"]'
    );
    links.forEach(patchLink);
  }

  // Run once on DOM ready, then observe for dynamically-injected buttons
  // (Leadong may render buttons after initial parse)
  function init() {
    patchAllLinks();

    var observer = new MutationObserver(function () {
      patchAllLinks();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
