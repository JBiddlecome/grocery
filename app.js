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
    const isProducts = tab === 'products';
    document.getElementById('tab-products').classList.toggle('hidden', !isProducts);
    document.getElementById('tab-deals').classList.toggle('hidden', isProducts);
    document.getElementById('nav-products').classList.toggle('active', isProducts);
    document.getElementById('nav-deals').classList.toggle('active', !isProducts);
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

// ── Start ─────────────────────────────────────────────────────────────────────
loadData();
