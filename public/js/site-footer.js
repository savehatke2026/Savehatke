/**
 * SaveHatke shared site footer — social links row.
 * Single source of truth for the footer social icons across every public page.
 *
 * Drop-in: add `<script src="js/site-footer.js"></script>` before </body> on any
 * page that has `<footer class="footer"> … <div class="fbot">`. On load this:
 *   1. injects the .fsocial / .fs-icon CSS (once per page),
 *   2. inserts the #fsocialRow container just before .fbot (if not already there),
 *   3. renders only the configured, valid profiles into it.
 *
 * To go live with a profile, set its real https URL below. YouTube/Facebook are
 * placeholders (YOUTUBE_URL / FACEBOOK_URL) and render as non-clickable disabled
 * icons until a real URL is set. Edit THIS one file and every page updates.
 */
(function () {
  'use strict';

  var SOCIAL_LINKS = {
    instagram: {
      label: 'Instagram',
      aria: 'Follow SaveHatke on Instagram',
      url: 'https://www.instagram.com/savehatke_deals?stkn=anRrMmNyNXI1dHd6'
    },
    youtube: {
      label: 'YouTube',
      aria: 'Follow SaveHatke on YouTube',
      url: 'YOUTUBE_URL'
    },
    facebook: {
      label: 'Facebook',
      aria: 'Follow SaveHatke on Facebook',
      url: 'FACEBOOK_URL'
    },
    whatsapp: {
      label: 'WhatsApp',
      aria: 'Follow the SaveHatke channel on WhatsApp',
      url: 'https://whatsapp.com/channel/0029Vb8JNfPAInPufsedM903'
    }
  };

  // Official brand marks, inline so they load instantly and never break on a
  // third-party icon CDN. Simple Icons paths, current-brand glyphs.
  var SOCIAL_ICONS = {
    instagram: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.015 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.9.419.424.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.902 1.382-.419.423-.824.683-1.38.9-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.902-.425-.424-.687-.824-.904-1.38-.18-.421-.374-1.065-.434-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.06-1.174.257-1.814.434-2.235.21-.57.479-.965.904-1.389.42-.424.816-.686 1.379-.902.405-.164 1.04-.361 2.21-.421 1.275-.045 1.656-.061 4.859-.061l.045.03zm0 3.678a6.162 6.162 0 100 12.324 6.162 6.162 0 100-12.324zM12 8a4 4 0 100 8 4 4 0 000-8zm7.846-5.385a1.441 1.441 0 01-2.88 0 1.44 1.44 0 012.88 0z"/></svg>',
    facebook:  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
    youtube:   '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.819a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
    whatsapp:  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.591.148-.12.297-.452.966-.616 1.164-.164.198-.322.223-.595.099-.273-.124-1.146-.423-2.183-1.347-.807-.719-1.352-1.607-1.51-1.88-.164-.273-.02-.421.12-.56.146-.148.322-.372.483-.56.164-.198.223-.346.346-.57.124-.223.074-.42-.025-.57-.099-.148-.59-1.416-.808-1.939-.213-.51-.43-.442-.59-.451-.153-.007-.329-.01-.505-.01a.972.972 0 00-.7.322c-.24.264-.919.898-.919 2.188 0 1.29.944 2.535 1.075 2.712.132.173 1.843 2.816 4.47 3.951.625.272 1.112.433 1.493.554.627.199 1.196.171 1.647.104.503-.075 1.549-.633 1.769-1.245.217-.612.217-1.137.151-1.246-.061-.108-.223-.171-.42-.293zM12.05 21.785h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.999-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.886 9.884zm8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L0 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>'
  };

  var CSS = `
.fsocial { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:10px; padding:0 0 22px; }
.fsocial[hidden] { display:none; }
.fs-icon { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; flex-shrink:0; color:#8ba2c4; background:rgba(15,30,58,.55); border:1px solid rgba(79,195,247,.12); transition:color .2s, border-color .2s, background .2s, transform .2s; }
.fs-icon:hover { transform:scale(1.06); }
.fs-icon.instagram { color:#E1306C; }
.fs-icon.youtube { color:#FF0000; }
.fs-icon.facebook { color:#1877F2; }
.fs-icon.whatsapp { color:#25D366; }
.fs-icon.instagram:hover { color:#E1306C; border-color:#E1306C; background:rgba(225,48,108,.08); }
.fs-icon.youtube:hover { color:#FF0000; border-color:#FF0000; background:rgba(255,0,0,.08); }
.fs-icon.facebook:hover { color:#1877F2; border-color:#1877F2; background:rgba(24,119,242,.08); }
.fs-icon.whatsapp:hover { color:#25D366; border-color:#25D366; background:rgba(37,211,102,.08); }
.fs-icon:focus-visible { color:#00E272; border-color:#00E272; outline:2px solid #00E272; outline-offset:3px; }
.fs-icon:hover:focus-visible { color:#00E272; border-color:#00E272; }
.fs-icon svg { width:16px; height:16px; display:block; fill:currentColor; }
.fs-icon img { width:16px; height:16px; display:block; object-fit:contain; }
.fs-icon[aria-disabled="true"] { cursor:default; }
@media(prefers-reduced-motion:reduce){ .fs-icon{transition:none} .fs-icon:hover{transform:none} }
@media(max-width:600px){ .fsocial{justify-content:center;padding-bottom:18px} }
`;

  function injectCSS() {
    if (document.getElementById('sh-footer-social-css')) return;
    var style = document.createElement('style');
    style.id = 'sh-footer-social-css';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureRow(footer) {
    var container = footer.querySelector('.container') || footer;
    var row = document.getElementById('fsocialRow');
    if (!row) {
      row = document.createElement('div');
      row.className = 'fsocial';
      row.id = 'fsocialRow';
      row.setAttribute('hidden', '');
      row.setAttribute('aria-label', 'Follow SaveHatke on social media');
      var fbot = container.querySelector('.fbot');
      if (fbot && fbot.parentNode === container) {
        container.insertBefore(row, fbot);
      } else {
        container.appendChild(row);
      }
    }
    return row;
  }

  function render() {
    var footer = document.querySelector('footer.footer');
    if (!footer) return;
    injectCSS();
    var row = ensureRow(footer);
    if (row.getAttribute('data-sh-rendered') === '1') return; // already done

    var frag = document.createDocumentFragment();
    Object.keys(SOCIAL_LINKS).forEach(function (key) {
      var entry = SOCIAL_LINKS[key];
      if (!entry || typeof entry.url !== 'string' || !entry.url.trim()) return;
      var placeholder = (key === 'youtube' && entry.url === 'YOUTUBE_URL') ||
        (key === 'facebook' && entry.url === 'FACEBOOK_URL');
      if (!placeholder) {
        try {
          var u = new URL(entry.url);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
        } catch (e) {
          return;
        }
      }
      var a = document.createElement('a');
      a.className = 'fs-icon ' + key;
      if (placeholder) {
        a.setAttribute('role', 'link');
        a.setAttribute('aria-disabled', 'true');
        a.tabIndex = 0;
      } else {
        a.href = entry.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      a.setAttribute('aria-label', entry.aria);
      a.title = entry.label;
      if (key === 'instagram') {
        var image = document.createElement('img');
        image.src = 'https://upload.wikimedia.org/wikipedia/commons/9/95/Instagram_logo_2022.svg?utm_source=commons.wikimedia.org&utm_campaign=index&utm_content=original';
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        image.addEventListener('error', function () {
          a.innerHTML = SOCIAL_ICONS.instagram;
        }, { once: true });
        a.appendChild(image);
      } else {
        a.innerHTML = SOCIAL_ICONS[key] || '';
      }
      frag.appendChild(a);
    });

    if (!frag.childNodes.length) return; // nothing configured — row stays hidden
    row.appendChild(frag);
    row.setAttribute('data-sh-rendered', '1');
    row.removeAttribute('hidden');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
