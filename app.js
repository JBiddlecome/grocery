let allData = [];
let allProducts = [];
let currentChart = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

async function loadData() {
    try {
        const res = await fetch('grocery_data_classified.csv');
        if (!res.ok) throw new Error('fetch failed');
        const text = await res.text();
        const result = Papa.parse(text, { header: true, skipEmptyLines: true });
        allData = result.data;
        init();
        loadCachedDeals();
    } catch {
        document.getElementById('product-body').innerHTML =
            '<tr><td colspan="5" class="loading-msg">Could not load data. Run <code>python server.py</code> to start the server.</td></tr>';
    }
}

// ── Data processing ───────────────────────────────────────────────────────────

function buildProducts(rows) {
    const map = {};
    for (const row of rows) {
        const name  = (row['item_basic'] || '').trim();
        const dept  = (row['department'] || '').trim();
        const price = parseFloat(row['Price Paid']);
        if (!name || isNaN(price)) continue;
        if (!map[name]) map[name] = { name, dept, count: 0, total: 0, prices: [], purchases: [] };
        const e = map[name];
        e.count++; e.total += price; e.prices.push(price);
        e.purchases.push({
            date:    (row['Date'] || '').trim(),
            store:   (row['Store'] || '').trim(),
            product: (row['Product / Item Name'] || '').trim(),
            brand:   (row['Brand'] || '').trim(),
            price
        });
    }
    return Object.values(map)
        .map(p => ({ ...p, avg: p.total / p.count, min: Math.min(...p.prices), max: Math.max(...p.prices) }))
        .sort((a, b) => b.count - a.count);
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
    allProducts = buildProducts(allData);
    populateDeptFilter(allProducts);
    renderList(allProducts);

    document.getElementById('search').addEventListener('input', applyFilters);
    document.getElementById('dept-filter').addEventListener('change', applyFilters);
    document.getElementById('back-btn').addEventListener('click', goBack);

    // Tab switching
    document.getElementById('nav-products').addEventListener('click', () => switchTab('products'));
    document.getElementById('nav-deals').addEventListener('click', () => switchTab('deals'));
    document.getElementById('nav-price-check').addEventListener('click', () => switchTab('price-check'));

    // Deals refresh
    document.getElementById('refresh-deals-btn').addEventListener('click', refreshDeals);
}

function applyFilters() {
    const q    = document.getElementById('search').value.trim().toLowerCase();
    const dept = document.getElementById('dept-filter').value;
    let filtered = allProducts;
    if (dept) filtered = filtered.filter(p => p.dept === dept);
    if (q)    filtered = filtered.filter(p => p.name.toLowerCase().includes(q));
    renderList(filtered);
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tab) {
    ['products', 'deals', 'price-check'].forEach(t => {
        document.getElementById(`tab-${t}`).classList.toggle('hidden', t !== tab);
        document.getElementById(`nav-${t}`).classList.toggle('active', t === tab);
    });
}

// ── List view ─────────────────────────────────────────────────────────────────

function populateDeptFilter(products) {
    const depts = [...new Set(products.map(p => p.dept).filter(Boolean))].sort();
    const sel   = document.getElementById('dept-filter');
    depts.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d; opt.textContent = d;
        sel.appendChild(opt);
    });
}

function renderList(products, dealSet) {
    const top   = products.slice(0, 100);
    const count = document.getElementById('result-count');
    const tbody = document.getElementById('product-body');

    count.textContent = products.length > 100
        ? `Showing top 100 of ${products.length} products`
        : `Showing ${products.length} product${products.length !== 1 ? 's' : ''}`;

    if (top.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading-msg">No products match your search.</td></tr>';
        return;
    }

    tbody.innerHTML = top.map((p, i) => {
        const hasDeal = dealSet && dealSet.has(p.name);
        return `<tr>
            <td class="rank-num col-rank">${i + 1}</td>
            <td>
                <span class="product-link" data-name="${esc(p.name)}">${esc(p.name)}</span>
                ${hasDeal ? '<span class="deal-pill">DEAL</span>' : ''}
            </td>
            <td><span class="dept-tag">${esc(p.dept)}</span></td>
            <td class="col-num count-cell">${p.count}</td>
            <td class="col-num price-cell">$${p.avg.toFixed(2)}</td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('.product-link').forEach(el =>
        el.addEventListener('click', () => showDetail(el.dataset.name))
    );
}

// ── Detail view ───────────────────────────────────────────────────────────────

function showDetail(name) {
    const product = allProducts.find(p => p.name === name);
    if (!product) return;

    document.getElementById('list-view').classList.add('hidden');
    document.getElementById('detail-view').classList.remove('hidden');
    window.scrollTo(0, 0);

    document.getElementById('detail-name').textContent  = product.name;
    document.getElementById('detail-dept').textContent  = product.dept;
    document.getElementById('detail-count').textContent = product.count;
    document.getElementById('detail-avg').textContent   = `$${product.avg.toFixed(2)}`;
    document.getElementById('detail-range').textContent = `$${product.min.toFixed(2)} – $${product.max.toFixed(2)}`;

    const sorted = [...product.purchases].sort((a, b) => parseDate(a.date) - parseDate(b.date));
    renderChart(sorted);
    renderHistory(sorted);
}

function goBack() {
    document.getElementById('detail-view').classList.add('hidden');
    document.getElementById('list-view').classList.remove('hidden');
    if (currentChart) { currentChart.destroy(); currentChart = null; }
    window.scrollTo(0, 0);
}

// ── Chart ─────────────────────────────────────────────────────────────────────

function renderChart(purchases) {
    if (currentChart) { currentChart.destroy(); currentChart = null; }
    const ctx    = document.getElementById('price-chart').getContext('2d');
    const labels = purchases.map(p => formatDateLabel(p.date));
    const data   = purchases.map(p => p.price);
    const stores = purchases.map(p => p.store);
    const avg    = data.reduce((s, v) => s + v, 0) / data.length;

    currentChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Price Paid',
                    data,
                    borderColor: '#2a7a48',
                    backgroundColor: 'rgba(42,122,72,0.07)',
                    pointBackgroundColor: '#2a7a48',
                    pointRadius: 5, pointHoverRadius: 7,
                    tension: 0.15, fill: true
                },
                {
                    label: 'Your Average',
                    data: data.map(() => avg),
                    borderColor: '#f0a500',
                    borderDash: [6, 4],
                    borderWidth: 1.5,
                    pointRadius: 0, tension: 0
                }
            ]
        },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'top' },
                tooltip: {
                    callbacks: {
                        afterLabel: (ctx) => {
                            if (ctx.datasetIndex === 0) return `Store: ${stores[ctx.dataIndex]}`;
                        },
                        label: (ctx) => ` $${ctx.parsed.y.toFixed(2)}`
                    }
                }
            },
            scales: {
                y: { ticks: { callback: v => `$${v.toFixed(2)}` }, grid: { color: '#f0f0f0' } },
                x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 0, maxTicksLimit: 14 } }
            }
        }
    });
}

// ── History table ─────────────────────────────────────────────────────────────

function renderHistory(purchases) {
    document.getElementById('history-body').innerHTML =
        [...purchases].reverse().map(p => `
            <tr>
                <td>${esc(p.date)}</td>
                <td>${esc(p.store)}</td>
                <td>${esc(p.product)}</td>
                <td>${esc(p.brand)}</td>
                <td class="col-num price-cell">$${p.price.toFixed(2)}</td>
            </tr>
        `).join('');
}

// ── Deals ─────────────────────────────────────────────────────────────────────

let currentDealSet = null;  // Set of product names that have active deals

async function loadCachedDeals() {
    try {
        const res = await fetch('/api/deals');
        if (!res.ok) return;
        const data = await res.json();
        if (data.deals && data.deals.length > 0) {
            renderDeals(data);
        }
    } catch {
        // Server not running (static file mode) — deals unavailable
    }
}

async function refreshDeals() {
    const btn   = document.getElementById('refresh-deals-btn');
    const icon  = document.getElementById('refresh-icon');
    const label = document.getElementById('refresh-label');
    const status = document.getElementById('deals-status');

    btn.disabled = true;
    icon.textContent = '⏳';
    label.textContent = 'Opening Ralphs…';
    status.className = 'deals-status info';
    status.textContent = 'A browser window will open and log into Ralphs. This takes about 60–90 seconds.';
    status.classList.remove('hidden');

    try {
        const res  = await fetch('/api/refresh-deals', { method: 'POST' });
        const data = await res.json();

        if (data.status === 'error' || data.error) {
            status.className = 'deals-status error';
            status.textContent = `Error: ${data.error || 'Unknown error'}`;
        } else {
            status.classList.add('hidden');
            renderDeals(data);
        }
    } catch (e) {
        status.className = 'deals-status error';
        status.textContent = 'Could not reach server. Make sure you started the app with python server.py (not serve.py).';
    } finally {
        btn.disabled = false;
        icon.textContent = '↺';
        label.textContent = 'Check Deals Now';
    }
}

function renderDeals(data) {
    const deals = data.deals || [];

    // Update summary bar
    const summaryEl = document.getElementById('deals-summary');
    summaryEl.classList.remove('hidden');
    document.getElementById('sum-coupons').textContent = data.total_coupons_scanned ?? '—';
    document.getElementById('sum-matches').textContent = deals.length;
    document.getElementById('sum-below').textContent   = deals.filter(d => d.is_below_avg).length;

    // Update last-updated line
    if (data.last_updated) {
        const dt = new Date(data.last_updated);
        document.getElementById('deals-last-updated').textContent =
            `Last checked: ${dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at ${dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    }

    // Badge on "Deals" nav button
    const belowAvg = deals.filter(d => d.is_below_avg).length;
    const badge = document.getElementById('deal-count-badge');
    if (belowAvg > 0) {
        badge.textContent = belowAvg;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }

    // Build a set of product names with deals → used to badge the product list
    currentDealSet = new Set(deals.map(d => d.product_name));
    applyFilters();  // Re-render product list to add DEAL badges

    // Render deals cards
    const body = document.getElementById('deals-body');

    if (deals.length === 0) {
        body.innerHTML = '<p class="loading-msg" style="padding:3rem 0">No matching deals found for your purchased products. Try refreshing — the weekly ad changes every Wednesday.</p>';
        return;
    }

    const belowDeals = deals.filter(d => d.is_below_avg);
    const otherDeals = deals.filter(d => !d.is_below_avg);

    let html = '';

    if (belowDeals.length > 0) {
        html += `<h3 class="deals-section-title">&#9733; Below Your Average Price</h3>`;
        html += belowDeals.map(d => dealCard(d)).join('');
    }

    if (otherDeals.length > 0) {
        html += `<h3 class="deals-section-title" style="margin-top:2rem">Other Matching Deals</h3>`;
        html += otherDeals.map(d => dealCard(d)).join('');
    }

    body.innerHTML = html;

    body.querySelectorAll('.deal-product-link').forEach(el =>
        el.addEventListener('click', () => {
            switchTab('products');
            showDetail(el.dataset.name);
        })
    );
}

function dealCard(d) {
    const savingsLine = d.deal_price != null
        ? `<span class="deal-price ${d.is_below_avg ? 'below-avg' : ''}">$${d.deal_price.toFixed(2)}</span>
           <span class="deal-vs">vs your avg <strong>$${d.avg_price.toFixed(2)}</strong></span>`
        : `<span class="deal-vs">Your avg: <strong>$${d.avg_price.toFixed(2)}</strong></span>`;

    const sourceLabel = d.source === 'coupon' ? '🏷 Coupon' : '📰 Weekly Ad';
    const belowBadge  = d.is_below_avg ? '<span class="below-badge">BELOW AVG</span>' : '';

    return `
        <div class="deal-card ${d.is_below_avg ? 'deal-card--highlight' : ''}">
            <div class="deal-card-top">
                <div>
                    <span class="deal-product-link product-link" data-name="${esc(d.product_name)}">${esc(d.product_name)}</span>
                    <span class="dept-tag" style="margin-left:.5rem">${esc(d.dept)}</span>
                    ${belowBadge}
                </div>
                <span class="deal-source">${sourceLabel}</span>
            </div>
            <p class="deal-text">"${esc(d.deal_text)}"</p>
            <div class="deal-pricing">
                ${savingsLine}
                <span class="deal-count">${d.purchase_count} purchases on record</span>
            </div>
        </div>
    `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseDate(str) {
    const [m, d, y] = str.split('/').map(Number);
    return new Date(y, m - 1, d);
}

function formatDateLabel(str) {
    try {
        return parseDate(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
    } catch { return str; }
}

// ── Price Check ───────────────────────────────────────────────────────────────

let pcProducts   = [];
let pcRunning    = false;   // true while any single item check is in flight

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('load-products-btn').addEventListener('click', loadPcProducts);
});

async function loadPcProducts() {
    const btn  = document.getElementById('load-products-btn');
    const body = document.getElementById('pc-body');
    btn.disabled = true;
    document.getElementById('load-products-icon').textContent = '⏳';
    body.innerHTML = '<p class="loading-msg" style="padding:2rem 0">Loading your products…</p>';

    try {
        const res  = await fetch('/api/price-check/products');
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        pcProducts = data;
        renderPcList(pcProducts);
    } catch (e) {
        body.innerHTML = `<p class="loading-msg" style="padding:2rem 0;color:#c0392b">
            Could not load products: ${esc(e.message)}<br>
            Make sure the server is running with <code>python server.py</code>.
        </p>`;
    } finally {
        btn.disabled = false;
        document.getElementById('load-products-icon').textContent = '↺';
    }
}

function renderPcList(products) {
    const body = document.getElementById('pc-body');
    if (!products.length) {
        body.innerHTML = '<p class="loading-msg" style="padding:2rem 0">No products found.</p>';
        return;
    }
    body.innerHTML = `
        <div class="table-wrap">
            <table id="pc-table">
                <thead>
                    <tr>
                        <th class="col-rank">#</th>
                        <th>Product</th>
                        <th>Dept</th>
                        <th class="col-num">Buys</th>
                        <th class="col-num">Avg Price</th>
                        <th>Brand</th>
                        <th>Size</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody id="pc-tbody"></tbody>
            </table>
        </div>
    `;

    const tbody = document.getElementById('pc-tbody');
    tbody.innerHTML = products.map((p, i) => `
        <tr id="pc-row-${i}" class="pc-row">
            <td class="rank-num col-rank">${i + 1}</td>
            <td><strong>${esc(p.item_basic)}</strong></td>
            <td><span class="dept-tag">${esc(p.department)}</span></td>
            <td class="col-num count-cell">${p.count}</td>
            <td class="col-num price-cell">$${p.avg_price.toFixed(2)}</td>
            <td>
                <input class="pc-input" id="pc-brand-${i}" type="text"
                       value="${esc(p.top_brand)}" placeholder="brand">
            </td>
            <td>
                <input class="pc-input pc-input--size" id="pc-size-${i}" type="text"
                       value="${esc(p.default_size)}" placeholder="size">
            </td>
            <td>
                <button class="pc-check-btn" id="pc-btn-${i}"
                        onclick="runPcItem(${i})">Check</button>
            </td>
        </tr>
        <tr id="pc-results-${i}" class="pc-results-row hidden">
            <td colspan="8" class="pc-results-cell">
                <div id="pc-results-inner-${i}"></div>
            </td>
        </tr>
    `).join('');
}

async function runPcItem(i) {
    if (pcRunning) {
        alert('A price check is already running. Please wait for it to finish.');
        return;
    }
    const p       = pcProducts[i];
    const brand   = document.getElementById(`pc-brand-${i}`).value.trim();
    const size    = document.getElementById(`pc-size-${i}`).value.trim();
    const btn     = document.getElementById(`pc-btn-${i}`);
    const inner   = document.getElementById(`pc-results-inner-${i}`);
    const resultsRow = document.getElementById(`pc-results-${i}`);
    const notice  = document.getElementById('pc-walmart-notice');

    pcRunning    = true;
    btn.disabled = true;
    btn.textContent = '…';
    notice.classList.remove('hidden');
    resultsRow.classList.remove('hidden');
    inner.innerHTML = `<p class="pc-checking-msg">
        🔍 Searching Ralphs and Walmart for <strong>${esc(brand || p.item_basic)} ${esc(size)}</strong>…
        <br><small>Walmart requires a browser window — this may take 10–30 seconds.</small>
    </p>`;

    try {
        const res  = await fetch('/api/price-check/item', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                item_basic: p.item_basic,
                brand,
                size,
                avg_price:  p.avg_price,
                generics:   true,
            }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        inner.innerHTML = renderPcResults(data, brand, p.avg_price);
    } catch (e) {
        inner.innerHTML = `<p style="color:#c0392b;padding:.75rem">Error: ${esc(e.message)}</p>`;
    } finally {
        pcRunning = false;
        btn.disabled = false;
        btn.textContent = 'Check';
        notice.classList.add('hidden');
    }
}

function renderPcResults(data, searchBrand, avgPrice) {
    const all = [
        ...(data.ralphs  || []),
        ...(data.walmart || []),
    ];

    if (!all.length) {
        return `<p class="pc-no-results">No results found at Ralphs or Walmart for this search.</p>`;
    }

    const brandLower = (searchBrand || '').toLowerCase();
    const exact    = all.filter(r => brandLower && r.brand.toLowerCase().includes(brandLower));
    const generics = all.filter(r => !exact.includes(r));
    const best     = all.reduce((a, b) => a.price < b.price ? a : b);

    const savingsTag = (price) => {
        const diff = +(price - avgPrice).toFixed(2);
        if (diff <= -0.50) return `<span class="pc-tag pc-tag--save">saves $${Math.abs(diff).toFixed(2)}</span>`;
        if (diff < 0)      return `<span class="pc-tag pc-tag--save">saves $${Math.abs(diff).toFixed(2)}</span>`;
        if (diff === 0)    return `<span class="pc-tag">same</span>`;
        if (diff < 0.50)   return `<span class="pc-tag pc-tag--warn">+$${diff.toFixed(2)}</span>`;
        return                    `<span class="pc-tag pc-tag--over">+$${diff.toFixed(2)}</span>`;
    };

    const row = (r, note) => `
        <tr>
            <td><span class="dept-tag dept-tag--store">${esc(r.store)}</span></td>
            <td>${esc(r.brand)}${note ? ` <span class="pc-generic-tag">${note}</span>` : ''}</td>
            <td>${esc(r.name)}</td>
            <td class="col-num">${esc(r.size)}</td>
            <td class="col-num price-cell">
                $${r.price.toFixed(2)}
                ${r.on_sale ? '<span class="deal-pill">SALE</span>' : ''}
            </td>
            <td>${savingsTag(r.price)}</td>
        </tr>`;

    const section = (title, items, note = '') => items.length ? `
        <tr class="pc-section-header"><td colspan="6">${title}</td></tr>
        ${items.slice(0, 5).map(r => row(r, note)).join('')}
    ` : '';

    const bestMsg = best.price < avgPrice
        ? `<div class="pc-best-deal">
               💡 Best deal: <strong>${esc(best.brand || 'store brand')}</strong>
               ${best.size ? `(${esc(best.size)})` : ''} at <strong>${esc(best.store)}</strong>
               — $${best.price.toFixed(2)}
               <span class="pc-tag pc-tag--save">saves $${(avgPrice - best.price).toFixed(2)}/unit</span>
           </div>`
        : '';

    return `
        ${bestMsg}
        <div class="pc-results-wrap">
            <p class="pc-avg-line">Your avg: <strong>$${avgPrice.toFixed(2)}</strong>
               &nbsp;·&nbsp; Range: $${Math.min(...all.map(r=>r.price)).toFixed(2)} – $${Math.max(...all.map(r=>r.price)).toFixed(2)} across both stores</p>
            <table class="pc-results-table">
                <thead>
                    <tr>
                        <th>Store</th><th>Brand</th><th>Product</th>
                        <th class="col-num">Size</th>
                        <th class="col-num">Price</th>
                        <th>vs. Avg</th>
                    </tr>
                </thead>
                <tbody>
                    ${section('— Your brand —', exact)}
                    ${section('— Alternatives / store brand —', generics, '')}
                </tbody>
            </table>
        </div>
    `;
}

// ── Start ─────────────────────────────────────────────────────────────────────
loadData();
