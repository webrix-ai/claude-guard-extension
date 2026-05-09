(function () {
  'use strict';

  var port = chrome.runtime.connect({ name: 'approve' });
  var listEl = document.getElementById('list');
  var emptyEl = document.getElementById('empty');
  var countEl = document.getElementById('count');
  var cards = new Map();

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function updateCount() {
    var n = cards.size;
    countEl.textContent = n + ' pending';
    countEl.hidden = n === 0;
    emptyEl.hidden = n > 0;
  }

  function formatHeaders(headers) {
    if (!headers || typeof headers !== 'object') return null;
    var keys = Object.keys(headers);
    if (keys.length === 0) return null;
    return keys.map(function (k) {
      var v = headers[k];
      if (/^authorization$/i.test(k) && v.length > 30) {
        v = v.slice(0, 25) + '\u2026' + v.slice(-4);
      }
      return esc(k) + ': ' + esc(v);
    }).join('\n');
  }

  function formatBody(body) {
    if (!body) return null;
    try {
      var parsed = JSON.parse(body);
      return esc(JSON.stringify(parsed, null, 2));
    } catch (e) {}
    return esc(body);
  }

  function addCard(req) {
    if (cards.has(req.id)) return;

    emptyEl.hidden = true;

    var mc = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].indexOf(req.method) !== -1 ? req.method : 'OTHER';

    var displayUrl = req.url;
    try {
      var u = new URL(req.url);
      displayUrl = u.protocol + '//' + u.host + u.pathname + (u.search || '');
    } catch (e) {}

    var headersHtml = formatHeaders(req.headers);
    var bodyHtml = formatBody(req.body);
    var hasDetails = headersHtml || bodyHtml;

    var detailsBlock = '';
    if (hasDetails) {
      detailsBlock = '<details class="drill">' +
        '<summary class="drill-toggle">Request Details</summary>' +
        '<div class="drill-body">';
      if (headersHtml) {
        detailsBlock += '<div class="drill-label">Headers</div>' +
          '<pre class="drill-pre">' + headersHtml + '</pre>';
      }
      if (bodyHtml) {
        detailsBlock += '<div class="drill-label">Body</div>' +
          '<pre class="drill-pre">' + bodyHtml + '</pre>';
      }
      detailsBlock += '</div></details>';
    }

    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = [
      '<div class="card-head">',
      '  <span class="method-badge ' + mc + '">' + esc(req.method) + '</span>',
      '  <span class="reason">' + esc(req.reason) + '</span>',
      '</div>',
      '<div class="url">' + esc(displayUrl) + '</div>',
      detailsBlock,
      '<div class="actions">',
      '  <button class="btn btn-deny">Deny</button>',
      '  <button class="btn btn-once">Allow Once</button>',
      '  <button class="btn btn-always">Always Allow</button>',
      '</div>'
    ].join('\n');

    function respond(action) {
      port.postMessage({ type: 'decision', id: req.id, action: action });
      card.classList.add('resolved');
      setTimeout(function () {
        card.remove();
        cards.delete(req.id);
        updateCount();
      }, 200);
    }

    card.querySelector('.btn-deny').onclick = function () { respond('deny'); };
    card.querySelector('.btn-once').onclick = function () { respond('allow-once'); };
    card.querySelector('.btn-always').onclick = function () { respond('allow-always'); };

    cards.set(req.id, card);
    listEl.appendChild(card);
    updateCount();
  }

  port.onMessage.addListener(function (msg) {
    if (msg.type === 'pending-requests') {
      msg.requests.forEach(addCard);
    }
    if (msg.type === 'new-request') {
      addCard(msg.request);
    }
  });

  port.postMessage({ type: 'ready' });
})();
