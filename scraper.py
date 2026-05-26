"""
Ralphs deal scraper.
- Logs in with Playwright (headed browser to avoid bot detection)
- Intercepts the Kroger JSON coupon API while loading the coupons page
- Falls back to DOM scraping if the API isn't captured
- Also scrapes the weekly ad page
- Matches deals to items in the user's grocery purchase history
- Saves results to deals.json
"""

import asyncio, json, os, csv, re
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).parent
CSV_FILE = BASE / 'grocery_data_classified.csv'
DEALS_FILE = BASE / 'deals.json'
SESSION_FILE = BASE / '.ralphs_session.json'

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'with', 'for',
    'oz', 'fl', 'lb', 'lbs', 'ct', 'pk', 'each', 'per', 'any', 'all',
    'get', 'buy', 'save', 'off', 'free', 'new', 'size', 'plus', 'value',
}


# ── Product data ──────────────────────────────────────────────────────────────

def load_user_products():
    products = {}
    with open(CSV_FILE, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            name = row.get('item_basic', '').strip()
            dept = row.get('department', '').strip()
            try:
                price = float(row.get('Price Paid', 0))
            except ValueError:
                continue
            if not name or price <= 0:
                continue
            if name not in products:
                products[name] = {'name': name, 'dept': dept, 'prices': [], 'count': 0}
            products[name]['prices'].append(price)
            products[name]['count'] += 1

    for p in products.values():
        p['avg_price'] = round(sum(p['prices']) / len(p['prices']), 2)
        p['min_price'] = round(min(p['prices']), 2)

    return products


# ── Matching ──────────────────────────────────────────────────────────────────

def keywords(text):
    text = re.sub(r'[^\w\s]', ' ', text.lower())
    return {w for w in text.split() if len(w) > 2 and w not in STOPWORDS and not w.isdigit()}


def match_score(item_basic, deal_text):
    item_kw = keywords(item_basic)
    deal_kw = keywords(deal_text)
    if not item_kw:
        return 0.0
    return len(item_kw & deal_kw) / len(item_kw)


def best_match(deal_text, user_products, threshold=0.5):
    best, best_score = None, 0.0
    for p in user_products.values():
        s = match_score(p['name'], deal_text)
        if s > best_score:
            best_score, best = s, p
    return (best, best_score) if best_score >= threshold else (None, 0.0)


# ── Playwright scraper ────────────────────────────────────────────────────────

async def scrape_ralphs(email, password):
    from playwright.async_api import async_playwright

    captured_coupons = []

    async with async_playwright() as pw:
        # Headed browser — Ralphs (Kroger) detects headless browsers and shows a CAPTCHA
        browser = await pw.chromium.launch(headless=False, slow_mo=250)

        ctx_args = {'viewport': {'width': 1280, 'height': 900}}
        if SESSION_FILE.exists():
            ctx_args['storage_state'] = str(SESSION_FILE)

        ctx = await browser.new_context(**ctx_args)
        page = await ctx.new_page()

        # Intercept Kroger's JSON coupon API responses
        async def on_response(resp):
            url = resp.url
            if ('coupon' in url or 'offer' in url) and 'api' in url:
                try:
                    if 'json' in resp.headers.get('content-type', ''):
                        data = await resp.json()
                        if isinstance(data, list):
                            captured_coupons.extend(data)
                        elif isinstance(data, dict):
                            for key in ('coupons', 'offers', 'data', 'results', 'items'):
                                if key in data and isinstance(data[key], list):
                                    captured_coupons.extend(data[key])
                                    break
                except Exception:
                    pass

        page.on('response', on_response)

        # ── Login ─────────────────────────────────────────────────────────────
        await page.goto('https://www.ralphs.com/signin?redirectUrl=/', wait_until='domcontentloaded', timeout=30000)
        await page.wait_for_timeout(2500)

        already_in = (
            await page.locator('[aria-label="My Account"]').count() > 0
            or await page.locator('text=Sign Out').count() > 0
            or await page.locator('text=My Account').count() > 0
        )

        if not already_in:
            try:
                # Ralphs login form uses name="id-email" / name="id-password"
                await page.locator('input[name="id-email"], input[type="email"]').first.fill(email, timeout=8000)
                await page.locator('input[name="id-password"], input[type="password"]').first.fill(password, timeout=5000)
                await page.locator('button[type="submit"]').first.click(timeout=5000)
                await page.wait_for_load_state('networkidle', timeout=25000)
            except Exception as e:
                await browser.close()
                return {'coupons': [], 'weekly_items': [], 'error': f'Login failed: {e}'}

        # Persist session so next run skips login
        await ctx.storage_state(path=str(SESSION_FILE))

        # ── Coupons page ──────────────────────────────────────────────────────
        await page.goto('https://www.ralphs.com/savings/cl/coupons/', wait_until='domcontentloaded', timeout=30000)
        await page.wait_for_timeout(5000)

        # Scroll to load all lazily-rendered coupons
        for _ in range(10):
            await page.keyboard.press('End')
            await page.wait_for_timeout(1000)

        # DOM fallback if API interception caught nothing
        if not captured_coupons:
            captured_coupons = await page.evaluate('''() => {
                const selectors = [
                    '[data-testid="CouponCard"]',
                    '[data-testid="coupon-card"]',
                    '[class*="CouponCard"]',
                    '[class*="coupon-card"]',
                    '[class*="couponCard"]',
                ];
                let cards = [];
                for (const sel of selectors) {
                    cards = [...document.querySelectorAll(sel)];
                    if (cards.length > 2) break;
                }
                // Absolute fallback: any list item with a price mention
                if (cards.length < 3) {
                    cards = [...document.querySelectorAll('[role="listitem"], article, li')].filter(el => {
                        const t = el.innerText || '';
                        return t.includes('$') || t.toLowerCase().includes('off') || t.toLowerCase().includes('save');
                    });
                }
                return cards.slice(0, 200).map(card => ({
                    dom_text: (card.innerText || '').substring(0, 400)
                }));
            }''')

        # ── Weekly ad ─────────────────────────────────────────────────────────
        weekly_items = []
        try:
            await page.goto('https://www.ralphs.com/weeklyad', wait_until='domcontentloaded', timeout=30000)
            await page.wait_for_timeout(4000)

            weekly_items = await page.evaluate('''() => {
                const priceRe = /\$[\d.]+/;
                const seen = new Set();
                const out = [];
                const candidates = document.querySelectorAll(
                    '[class*="item"], [class*="product"], [class*="deal"], [class*="tile"], [class*="ad-item"], [class*="circular"]'
                );
                for (const el of candidates) {
                    const txt = (el.innerText || '').trim();
                    if (txt && priceRe.test(txt) && txt.length > 5 && txt.length < 300 && !seen.has(txt)) {
                        seen.add(txt);
                        out.push({ dom_text: txt });
                    }
                }
                // Broader fallback
                if (out.length < 5) {
                    document.querySelectorAll('p, span, div').forEach(el => {
                        if (el.children.length > 0) return;
                        const txt = (el.innerText || '').trim();
                        if (txt && priceRe.test(txt) && txt.length > 5 && txt.length < 150 && !seen.has(txt)) {
                            seen.add(txt);
                            out.push({ dom_text: txt });
                        }
                    });
                }
                return out.slice(0, 100);
            }''')
        except Exception:
            pass

        await browser.close()

    return {'coupons': captured_coupons, 'weekly_items': weekly_items, 'error': None}


# ── Orchestrator ──────────────────────────────────────────────────────────────

async def run_scraper():
    email = os.getenv('RALPHS_EMAIL', '')
    password = os.getenv('RALPHS_PASSWORD', '')

    if not email or not password:
        return {'error': 'Credentials missing — check the .env file.', 'deals': []}

    user_products = load_user_products()
    raw = await scrape_ralphs(email, password)

    deals = {}

    def try_add(deal_text, source):
        if not deal_text or not deal_text.strip():
            return
        product, score = best_match(deal_text, user_products, threshold=0.5)
        if not product:
            return

        # Grab the lowest dollar amount mentioned (most likely the sale price)
        prices = [float(x) for x in re.findall(r'\$(\d+\.?\d*)', deal_text)]
        deal_price = min(prices) if prices else None

        key = product['name']
        if key not in deals or score > deals[key]['match_score']:
            deals[key] = {
                'product_name': product['name'],
                'dept': product['dept'],
                'avg_price': product['avg_price'],
                'purchase_count': product['count'],
                'deal_text': deal_text[:280],
                'source': source,
                'deal_price': deal_price,
                'match_score': round(score, 2),
                'is_below_avg': deal_price is not None and deal_price < product['avg_price'],
            }

    for c in raw.get('coupons', []):
        # Structured JSON fields (Kroger API)
        text = ' '.join(str(c.get(k) or '') for k in (
            'description', 'shortDescription', 'brand', 'title',
            'name', 'categoryName', 'dom_text',
        ))
        try_add(text, 'coupon')

    for item in raw.get('weekly_items', []):
        try_add(item.get('dom_text', ''), 'weekly_ad')

    result_list = sorted(
        deals.values(),
        key=lambda d: (d['is_below_avg'], d['match_score']),
        reverse=True,
    )

    output = {
        'deals': result_list,
        'total_coupons_scanned': len(raw.get('coupons', [])),
        'total_ad_items_scanned': len(raw.get('weekly_items', [])),
        'matches_found': len(result_list),
        'last_updated': datetime.now().isoformat(),
        'error': raw.get('error'),
    }

    DEALS_FILE.write_text(json.dumps(output, indent=2))
    return output


if __name__ == '__main__':
    from dotenv import load_dotenv
    load_dotenv()
    asyncio.run(run_scraper())
