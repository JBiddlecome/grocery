#!/usr/bin/env python3
"""
price_checker.py — Local CLI tool to compare your average grocery prices
against current prices at Ralphs (Kroger API) and Walmart.

Run:  python price_checker.py
"""

import asyncio, csv, json, os, re, sys
import requests
from pathlib import Path
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

BASE             = Path(__file__).parent
CSV_FILE         = BASE / 'grocery_data_classified.csv'
RESULTS_FILE     = BASE / 'price_check_results.json'
TOKEN_CACHE_FILE = BASE / '.kroger_token_cache.json'

KROGER_STORE_ID       = '70300648'  # Ralphs, 2600 W Victory Blvd, Burbank
WALMART_ZIP           = '91505'
KROGER_API_BASE       = 'https://api.kroger.com/v1'
WALMART_SESSION_FILE  = BASE / '.walmart_session.json'


# ── CSV / product data ────────────────────────────────────────────────────────

def load_ranked_products(min_purchases=2):
    """Load and rank products from CSV by purchase frequency."""
    items = {}

    with open(CSV_FILE, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            item_basic = row.get('item_basic', '').strip()
            brand      = row.get('Brand', '').strip()
            full_name  = row.get('Product / Item Name', '').strip()
            try:
                price = float(row.get('Price Paid', 0))
            except ValueError:
                continue
            if not item_basic or price <= 0:
                continue

            if item_basic not in items:
                items[item_basic] = {
                    'item_basic':  item_basic,
                    'department':  row.get('department', '').strip(),
                    'prices':      [],
                    'brands':      {},
                    'full_names':  {},
                    'count':       0,
                }

            d = items[item_basic]
            d['prices'].append(price)
            d['count'] += 1
            d['brands'][brand]          = d['brands'].get(brand, 0) + 1
            d['full_names'][full_name]  = d['full_names'].get(full_name, 0) + 1

    results = []
    for d in items.values():
        if d['count'] < min_purchases:
            continue
        d['avg_price']     = round(sum(d['prices']) / len(d['prices']), 2)
        d['min_price']     = round(min(d['prices']), 2)
        d['max_price']     = round(max(d['prices']), 2)
        d['top_brand']     = max(d['brands'],     key=d['brands'].get)     if d['brands']     else ''
        d['top_full_name'] = max(d['full_names'], key=d['full_names'].get) if d['full_names'] else ''
        results.append(d)

    return sorted(results, key=lambda x: x['count'], reverse=True)


# ── Kroger API ────────────────────────────────────────────────────────────────

def get_kroger_token():
    """Fetch OAuth2 client-credentials token, cached until near-expiry."""
    if TOKEN_CACHE_FILE.exists():
        try:
            cache = json.loads(TOKEN_CACHE_FILE.read_text())
            if datetime.fromisoformat(cache['expires_at']) > datetime.now():
                return cache['access_token']
        except Exception:
            pass

    client_id     = os.getenv('KROGER_CLIENT_ID', '')
    client_secret = os.getenv('KROGER_CLIENT_SECRET', '')
    if not client_id or not client_secret:
        print('❌  KROGER_CLIENT_ID / KROGER_CLIENT_SECRET missing in .env')
        return None

    resp = requests.post(
        f'{KROGER_API_BASE}/connect/oauth2/token',
        data={'grant_type': 'client_credentials', 'scope': 'product.compact'},
        auth=(client_id, client_secret),
        timeout=10,
    )
    if resp.status_code != 200:
        print(f'❌  Kroger auth failed: {resp.status_code}  {resp.text[:200]}')
        return None

    data       = resp.json()
    token      = data['access_token']
    expires_at = (datetime.now() + timedelta(seconds=data.get('expires_in', 1800) - 60)).isoformat()
    TOKEN_CACHE_FILE.write_text(json.dumps({'access_token': token, 'expires_at': expires_at}))
    return token


def search_kroger(query, token, limit=10):
    """Search Kroger Products API for the local Ralphs store."""
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json'}
    params  = {
        'filter.term':        query,
        'filter.locationId':  KROGER_STORE_ID,
        'filter.limit':       limit,
        'filter.fulfillment': 'ais',   # available in store
    }

    resp = requests.get(f'{KROGER_API_BASE}/products', headers=headers, params=params, timeout=10)
    if resp.status_code != 200:
        return []

    results = []
    for p in resp.json().get('data', []):
        items_list  = p.get('items', [{}])
        price_info  = items_list[0].get('price', {}) if items_list else {}
        regular     = price_info.get('regular')
        promo       = price_info.get('promo')
        if regular is None:
            continue
        current = promo if (promo is not None and promo < regular) else regular

        results.append({
            'store':          'Ralphs',
            'brand':          p.get('brand', ''),
            'name':           p.get('description', ''),
            'size':           items_list[0].get('size', '') if items_list else '',
            'price':          round(float(current), 2),
            'regular_price':  round(float(regular), 2),
            'on_sale':        promo is not None and promo < regular,
        })
    return results


# ── Walmart search (Playwright) ───────────────────────────────────────────────
# Walmart blocks plain HTTP requests via PerimeterX, so we use a real browser.
# Each call opens its own browser, searches, and closes — simple and reliable.

def _parse_price_string(s):
    """Extract a float from a price string like '$2.52' or '2.52'."""
    if not s:
        return None
    m = re.search(r'[\d]+\.?\d*', str(s).replace(',', ''))
    return float(m.group()) if m else None


def _parse_walmart_items(raw_items, limit=10):
    results = []
    for item in raw_items[:limit]:
        try:
            pi      = item.get('priceInfo', {}) or {}
            # Walmart uses linePrice as the displayed shelf price string
            current = (
                _parse_price_string(pi.get('linePrice'))
                or _parse_price_string(pi.get('itemPrice'))
                or _parse_price_string(pi.get('currentPrice'))
                or (pi.get('minPrice') if pi.get('minPrice') else None)
            )
            if not current:
                continue

            name  = (item.get('name') or item.get('title') or '').strip()
            brand = (item.get('brand') or '').strip()

            # Extract size from product name if brand is empty
            if not brand:
                brand_match = re.match(r'^([A-Z][A-Za-z&\'\. ]{1,20})\s', name)
                brand = brand_match.group(1).strip() if brand_match else ''

            size_match = re.search(
                r'(\d+\.?\d*\s*(?:oz|fl\.?\s*oz|lb|lbs|ct|count|pk|pack|gal|gallon|qt|quart))',
                name, re.I,
            )
            size = size_match.group(1).strip() if size_match else ''

            was     = _parse_price_string(pi.get('wasPrice'))
            on_sale = was is not None and was > current

            results.append({
                'store':         'Walmart',
                'brand':         brand,
                'name':          name,
                'size':          size,
                'price':         round(current, 2),
                'regular_price': round(was if was else current, 2),
                'on_sale':       on_sale,
            })
        except Exception:
            continue
    return results


def _make_walmart_context(pw):
    """Create a Playwright browser context, restoring saved session if available."""
    browser = pw.chromium.launch(
        headless=False,
        args=['--disable-blink-features=AutomationControlled'],
    )
    ctx_args = {
        'viewport':    {'width': 1280, 'height': 900},
        'user_agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) '
                       'Chrome/124.0.0.0 Safari/537.36',
    }
    if WALMART_SESSION_FILE.exists():
        ctx_args['storage_state'] = str(WALMART_SESSION_FILE)
    ctx = browser.new_context(**ctx_args)
    return browser, ctx


def _extract_walmart_results(page, limit=10):
    nd_text = page.evaluate('''() => {
        const el = document.getElementById("__NEXT_DATA__");
        return el ? el.textContent : null;
    }''')
    if not nd_text:
        return []
    nd     = json.loads(nd_text)
    stacks = nd['props']['pageProps']['initialData']['searchResult']['itemStacks']
    raw    = []
    for stack in stacks:
        raw.extend(stack.get('items', []))
    return _parse_walmart_items(raw, limit)


def search_walmart(query, zip_code=WALMART_ZIP, limit=10):
    """Search Walmart using Playwright.
    On first run (or expired session) pauses for you to solve the CAPTCHA,
    then saves the session so future runs skip it automatically.
    """
    from playwright.sync_api import sync_playwright

    url = f'https://www.walmart.com/search?q={requests.utils.quote(query)}&zipCode={zip_code}'

    with sync_playwright() as pw:
        browser, ctx = _make_walmart_context(pw)
        page = ctx.new_page()
        page.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")

        try:
            page.goto(url, wait_until='domcontentloaded', timeout=25000)
            page.wait_for_timeout(3000)

            # Detect CAPTCHA / bot wall by title or body text
            title     = page.title().lower()
            body_text = page.inner_text('body').lower()[:500]
            is_captcha = (
                'robot' in title or 'captcha' in title or 'blocked' in title
                or 'activate and hold' in body_text
                or 'confirm that you' in body_text
                or 'robot or human' in body_text
            )
            if is_captcha:
                # Web-friendly: auto-wait up to 90s for user to solve CAPTCHA in the browser.
                # (CLI users see a printed hint; web users just interact with the open window.)
                print('\n  ⚠️  Walmart CAPTCHA — solve it in the browser window. Waiting up to 90s...')
                try:
                    page.wait_for_function(
                        """() => {
                            const t = (document.title || '').toLowerCase();
                            const b = (document.body ? document.body.innerText : '').toLowerCase().substring(0, 500);
                            return !t.includes('robot') && !b.includes('activate and hold')
                                   && document.getElementById('__NEXT_DATA__') !== null;
                        }""",
                        timeout=90000,
                    )
                    page.wait_for_timeout(1500)
                except Exception:
                    pass  # timed out — try to extract whatever is on the page

            # Save session for next run
            ctx.storage_state(path=str(WALMART_SESSION_FILE))

            results = _extract_walmart_results(page, limit)
        except Exception:
            results = []
        finally:
            browser.close()

    return results


# ── Display helpers ───────────────────────────────────────────────────────────

W = 66   # display width

def print_header():
    print('\n' + '═' * W)
    print('  🛒  Grocery Price Checker  ·  Ralphs & Walmart')
    print('═' * W)

def print_divider():
    print('\n' + '─' * W)

def savings_tag(price, avg):
    diff = round(price - avg, 2)
    if diff <= -0.50:  return f'✅ saves ${abs(diff):.2f}'
    if diff <  0:      return f'✅ saves ${abs(diff):.2f}'
    if diff == 0:      return '➖ same'
    if diff <  0.50:   return f'⚠️  +${diff:.2f}'
    return              f'❌ +${diff:.2f}'

def print_results(all_results, avg_price, top_brand):
    if not all_results:
        print('\n  No results found on either store.')
        return

    brand_lower = top_brand.lower() if top_brand else ''
    exact    = [r for r in all_results if brand_lower and brand_lower in r['brand'].lower()]
    generics = [r for r in all_results if r not in exact]

    header = f"  {'Store':<10} {'Brand':<20} {'Size':<12} {'Price':<8} {'':6}  vs. avg ${avg_price:.2f}"
    print(f'\n{header}')
    print('  ' + '─' * (W - 2))

    def row(r, note=''):
        sale  = '🏷️ SALE' if r['on_sale'] else '      '
        tag   = savings_tag(r['price'], avg_price)
        label = f'  [{note}]' if note else ''
        print(f"  {r['store']:<10} {r['brand'][:20]:<20} {r['size'][:12]:<12} "
              f"${r['price']:<7.2f} {sale}  {tag}{label}")

    if exact:
        print('  ── Your brand ──')
        for r in exact[:4]:
            row(r)

    if generics:
        print('  ── Alternatives / store brand ──')
        for r in generics[:4]:
            note = 'generic' if not r['brand'] or r['brand'].lower() in ('', 'none') else ''
            row(r, note)

    best = min(all_results, key=lambda r: r['price'])
    if best['price'] < avg_price:
        savings = round(avg_price - best['price'], 2)
        print(f'\n  💡 Best deal: {best["brand"] or "store brand"} '
              f'({best["size"]}) at {best["store"]} — '
              f'${best["price"]:.2f}  (saves ${savings:.2f} vs. your avg)')


# ── Interactive prompt helpers ────────────────────────────────────────────────

def ask(prompt, default=''):
    val = input(f'  {prompt} [{default}]: ').strip() if default else input(f'  {prompt}: ').strip()
    return val if val else default

def extract_size(text):
    m = re.search(
        r'(\d+\.?\d*\s*(?:oz|fl\.?\s*oz|lb|lbs|ct|count|pk|pack|gal|gallon|qt|quart))',
        text, re.I,
    )
    return m.group(1).strip() if m else ''


# ── Main ──────────────────────────────────────────────────────────────────────

def run():
    print_header()

    print('\nLoading purchase history...')
    products = load_ranked_products(min_purchases=2)
    print(f'Found {len(products)} products (2+ purchases), ranked by frequency.\n')

    try:
        top_n = int(ask('How many top items to check', '10'))
    except ValueError:
        top_n = 10

    print('\nConnecting to Kroger API...')
    token = get_kroger_token()
    if not token:
        sys.exit(1)
    print('✅ Kroger authenticated.\n')

    session_results = []

    for i, product in enumerate(products[:top_n], 1):
        print_divider()
        print(f'\nItem {i} / {top_n}:  {product["item_basic"]}  '
              f'({product["department"]})')
        print(f'  Purchased:  {product["count"]}x   |   '
              f'Avg: ${product["avg_price"]:.2f}   '
              f'(${product["min_price"]:.2f} – ${product["max_price"]:.2f})')
        print(f'  Top brand:  {product["top_brand"] or "(none)"}')
        print(f'  Example:    {product["top_full_name"][:62]}')

        print()
        choice = input('  Search this item?  [Y / n / q to quit]: ').strip().lower()
        if choice == 'q':
            break
        if choice == 'n':
            continue

        # Confirm / override search details
        brand = ask('Brand to search', product['top_brand'])
        size  = ask('Size / quantity',  extract_size(product['top_full_name']))
        also_generic = input('  Also search store-brand alternatives? [Y/n]: '
                             ).strip().lower() != 'n'

        # Build primary query (brand + category + size)
        query = ' '.join(p for p in [brand, product['item_basic'], size] if p)
        print(f'\n  🔍  Searching: "{query}"')

        kroger_results  = []
        walmart_results = []

        try:
            kroger_results = search_kroger(query, token)
            print(f'       Ralphs  → {len(kroger_results)} result(s)')
        except Exception as e:
            print(f'       Ralphs  → error: {e}')

        try:
            walmart_results = search_walmart(query)
            print(f'       Walmart → {len(walmart_results)} result(s)')
        except Exception as e:
            print(f'       Walmart → error: {e}')

        # Generic / store-brand search (no brand name)
        if also_generic and brand:
            generic_q = ' '.join(p for p in [product['item_basic'], size] if p)
            print(f'  🔍  Generics:  "{generic_q}"')
            try:
                extras = search_kroger(generic_q, token)
                seen   = {r['name'] for r in kroger_results}
                kroger_results += [r for r in extras if r['name'] not in seen]
                print(f'       Ralphs  → {len(extras)} more')
            except Exception:
                pass
            try:
                extras = search_walmart(generic_q)
                seen   = {r['name'] for r in walmart_results}
                walmart_results += [r for r in extras if r['name'] not in seen]
                print(f'       Walmart → {len(extras)} more')
            except Exception:
                pass

        all_results = kroger_results + walmart_results
        print_results(all_results, product['avg_price'], brand)

        session_results.append({
            'item_basic':    product['item_basic'],
            'avg_price':     product['avg_price'],
            'purchase_count': product['count'],
            'search_brand':  brand,
            'search_size':   size,
            'search_query':  query,
            'results':       all_results,
            'checked_at':    datetime.now().isoformat(),
        })

        print()
        if i < min(top_n, len(products)):
            cont = input('  Press Enter for next item  (q to quit): ').strip().lower()
            if cont == 'q':
                break

    # Save session
    if session_results:
        RESULTS_FILE.write_text(json.dumps(session_results, indent=2))
        print(f'\n✅  Results saved → price_check_results.json')

    print('\n' + '═' * W)
    print('  Done.')
    print('═' * W + '\n')


if __name__ == '__main__':
    run()
