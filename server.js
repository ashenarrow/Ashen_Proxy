const express = require('express');
const cors = require('cors');
const compression = require('compression');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Use compression middleware to improve performance.
app.use(compression());
app.use(cors({ origin: '*' }));

// Serve static files from the "src" folder.
app.use(express.static(path.join(__dirname, 'src')));

// In‑memory mapping: token -> original URL
const urlMapping = new Map();
// In‑memory response cache: token -> { data, headers, expires }
const responseCache = new Map();
const CACHE_DURATION = 60 * 1000; // 60 seconds for non-HTML assets

// Generate a random numeric token (as a string) for a given URL.
function generateToken() {
  // Generate 4 random bytes, convert to a number.
  const num = parseInt(crypto.randomBytes(4).toString('hex'), 16);
  return num.toString();
}

// Look up a token for a URL, or generate one if not already mapped.
function getTokenForUrl(url) {
  for (const [token, mappedUrl] of urlMapping.entries()) {
    if (mappedUrl === url) return token;
  }
  const token = generateToken();
  urlMapping.set(token, url);
  return token;
}

// Retrieve the URL from a given token.
function getUrlFromToken(token) {
  return urlMapping.get(token);
}

// Middleware: if path begins with /http:// or /https://, generate token and redirect.
app.use((req, res, next) => {
  if (/^\/https?:\/\//.test(req.path)) {
    const fullUrl = req.originalUrl.slice(1);
    const token = getTokenForUrl(fullUrl);
    return res.redirect('/proxy/' + token);
  }
  next();
});

// Route: /proxy?url=... (generates token and redirects)
app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing "url" query parameter.');
  const token = getTokenForUrl(targetUrl);
  res.redirect('/proxy/' + token);
});

// Helper: Ensure URL ends with a slash.
function ensureTrailingSlash(urlStr) {
  return urlStr.endsWith('/') ? urlStr : urlStr + '/';
}

// Main proxy route: /proxy/:token
app.get('/proxy/:token', async (req, res) => {
  const token = req.params.token;
  const targetUrl = getUrlFromToken(token);
  if (!targetUrl) return res.status(404).send('URL not found for token.');

  // Check cache for non-HTML responses.
  const now = Date.now();
  if (responseCache.has(token)) {
    const cacheEntry = responseCache.get(token);
    if (now < cacheEntry.expires) {
      for (const header in cacheEntry.headers) {
        res.setHeader(header, cacheEntry.headers[header]);
      }
      return res.send(cacheEntry.data);
    } else {
      responseCache.delete(token);
    }
  }

  try {
    // Fetch the target URL.
    const response = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      maxRedirects: 5, // follow up to 5 redirects
      validateStatus: null,
    });
    
    // If it's a redirect, handle it by updating the token mapping.
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      const redirectUrl = new URL(response.headers.location, targetUrl).toString();
      const newToken = getTokenForUrl(redirectUrl);
      return res.redirect('/proxy/' + newToken);
    }
    
    const contentType = response.headers['content-type'] || '';
    let effectiveUrl =
      (response.request &&
       response.request.res &&
       response.request.res.responseUrl) ||
      targetUrl;
    effectiveUrl = ensureTrailingSlash(effectiveUrl);
    
    // If HTML, process it with Cheerio.
    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      const $ = cheerio.load(html);
      
      // Remove existing <base> tags.
      $('base').remove();
      
      // Rewrite URLs into tokenized proxy URLs.
      const rewriteUrl = (link) => {
        try {
          if (link.startsWith('//')) link = 'https:' + link;
          const absoluteUrl = link.startsWith('http')
            ? link
            : new URL(link, effectiveUrl).toString();
          const newToken = getTokenForUrl(absoluteUrl);
          return '/proxy/' + newToken;
        } catch (err) {
          return link;
        }
      };
      
      // Rewrite anchors, images, scripts, links, and forms.
      $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
          $(el).attr('href', rewriteUrl(href));
          $(el).removeAttr('target');
          $(el).removeAttr('onclick');
        }
      });
      $('img, script, link').each((i, el) => {
        const src = $(el).attr('src');
        if (src) $(el).attr('src', rewriteUrl(src));
      });
      $('form').each((i, el) => {
        const action = $(el).attr('action');
        if (action) {
          $(el).attr('action', rewriteUrl(action));
          $(el).removeAttr('target');
        }
      });
      
      // Inject a client-side script to override navigation.
      // This script updates the parent URL (e.g. /p/<token>) on link clicks and handles popstate.
      const injectedScript = `
        (function() {
          const currentToken = "${token}";
          function updateParentUrl(newToken) {
            history.pushState({token: newToken}, "", "/p/" + newToken);
          }
          document.addEventListener('click', function(e) {
            let el = e.target;
            while (el && el.tagName !== 'A') { el = el.parentElement; }
            if (el && el.tagName === 'A') {
              const href = el.getAttribute('href');
              if (href && href.startsWith('/proxy/')) {
                e.preventDefault();
                const newToken = href.split('/').pop();
                updateParentUrl(newToken);
                window.location.href = href;
              }
            }
          }, true);
          window.addEventListener('popstate', function(e) {
            if (e.state && e.state.token) {
              window.location.href = "/proxy/" + e.state.token;
            }
          });
          if (!history.state) {
            history.replaceState({token: currentToken}, "", "/p/" + currentToken);
          }
        })();
      `;
      $('body').append(`<script>${injectedScript}</script>`);
      
      res.set('Content-Type', 'text/html');
      return res.send($.html());
    } else {
      // For non-HTML assets, cache them for CACHE_DURATION.
      const headers = response.headers;
      responseCache.set(token, {
        data: response.data,
        headers,
        expires: now + CACHE_DURATION,
      });
      for (const header in headers) {
        res.setHeader(header, headers[header]);
      }
      return res.send(response.data);
    }
  } catch (error) {
    console.error('Error fetching target URL:', error);
    return res.status(500).send(`Error: ${error.toString()}`);
  }
});

// Fallback route for unmatched requests.
app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Enhanced CORS proxy is running on port ${PORT}`);
});
