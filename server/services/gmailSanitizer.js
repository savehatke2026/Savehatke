// ============================================
// SaveHatke — Email HTML Sanitizer
// Server-side allowlist sanitization of email bodies
// using jsdom. Output is additionally rendered inside a
// fully sandboxed iframe (no scripts) on the frontend.
// ============================================

let JSDOM = null;
try {
  // jsdom is installed at the repo root; resolution walks up from server/
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  JSDOM = null;
}

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'acronym', 'address', 'b', 'bdi', 'bdo', 'blockquote', 'br',
  'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
]);

// Attributes permitted on any element
const GLOBAL_ATTRS = new Set([
  'align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'color',
  'colspan', 'dir', 'height', 'lang', 'rowspan', 'scope', 'title', 'valign',
  'width', 'datetime',
]);

// style values that may never reference external/executable content
const DANGEROUS_STYLE = /url\s*\(|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|@import/i;

function isSafeUrl(value, allowDataImage = false) {
  const v = String(value || '').trim().toLowerCase().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!v) return false;
  if (v.startsWith('http://') || v.startsWith('https://') || v.startsWith('mailto:') || v.startsWith('tel:')) return true;
  if (allowDataImage && /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(v) && v.length < 500000) return true;
  // relative paths are acceptable (they can't execute anything)
  if (/^[#/?.]/.test(v) && !v.startsWith('//')) return true;
  return false;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/**
 * Sanitize untrusted email HTML. Always returns a string.
 * Falls back to escaped plain text if jsdom is unavailable.
 */
function sanitizeEmailHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return '';

  if (!JSDOM) {
    return `<pre>${escapeHtml(html)}</pre>`;
  }

  try {
    const dom = new JSDOM(`<div id="__root">${html}</div>`);
    const { document } = dom.window;
    const root = document.getElementById('__root');

    const walk = (node) => {
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (child.nodeType === 1) { // element
          const tag = child.tagName.toLowerCase();

          // Drop dangerous elements entirely (script, style, iframe, object,
          // embed, form, input, link, meta, base, svg, math, video, audio, source...)
          if (!ALLOWED_TAGS.has(tag)) {
            // Remove these along with ALL their content (never unwrap text/executable bodies)
            if (['script', 'style', 'noscript', 'template', 'title', 'textarea', 'head', 'iframe', 'object', 'embed'].includes(tag)) {
              child.remove();
              continue;
            }
            // unwrap unknown-but-structural tags by replacing with their children
            const frag = document.createDocumentFragment();
            while (child.firstChild) frag.appendChild(child.firstChild);
            node.replaceChild(frag, child);
            walk(node);
            return;
          }

          // Scrub attributes
          for (const attr of Array.from(child.attributes)) {
            const name = attr.name.toLowerCase();
            const value = attr.value;

            if (name.startsWith('on') || name === 'srcset' || name === 'usemap'
              || name === 'formaction' || name === 'xlink:href' || name === 'ping') {
              child.removeAttribute(attr.name);
              continue;
            }

            if (name === 'href') {
              if (!isSafeUrl(value)) child.removeAttribute(attr.name);
            } else if (name === 'src') {
              if (tag === 'img' && isSafeUrl(value, true)) {
                // keep
              } else {
                child.removeAttribute(attr.name);
              }
            } else if (name === 'style') {
              if (DANGEROUS_STYLE.test(value)) {
                child.removeAttribute(attr.name);
              } else {
                // keep only simple declarations
                const cleaned = value
                  .split(';')
                  .map((d) => d.trim())
                  .filter((d) => d && /^[a-z-]+\s*:\s*[^;{}]+$/i.test(d))
                  .filter((d) => !DANGEROUS_STYLE.test(d))
                  .join('; ');
                if (cleaned) child.setAttribute('style', cleaned);
                else child.removeAttribute(attr.name);
              }
            } else if (name === 'class' || name === 'id') {
              child.removeAttribute(attr.name);
            } else if (!GLOBAL_ATTRS.has(name)) {
              child.removeAttribute(attr.name);
            } else if (/javascript\s*:/i.test(value)) {
              child.removeAttribute(attr.name);
            }
          }

          // External links open safely
          if (tag === 'a') {
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer');
          }

          walk(child);
        } else if (child.nodeType === 8) { // comment
          child.remove();
        }
      }
    };

    walk(root);
    return root.innerHTML;
  } catch (e) {
    // Fail closed: render as escaped plain text
    return `<pre>${escapeHtml(html)}</pre>`;
  }
}

/**
 * Extract a short plain-text preview from an email body (html or text).
 */
function toPlainText(body, isHtml) {
  if (!body) return '';
  if (!isHtml) return String(body).replace(/\s+/g, ' ').trim();
  try {
    if (!JSDOM) return escapeHtml(body).slice(0, 500);
    const dom = new JSDOM(body);
    return (dom.window.document.body?.textContent || '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    return '';
  }
}

module.exports = { sanitizeEmailHtml, toPlainText, escapeHtml };
