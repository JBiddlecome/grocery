from flask import Flask, jsonify, send_from_directory, request
from pathlib import Path
from dotenv import load_dotenv
import json, asyncio, threading, traceback

load_dotenv()

BASE = Path(__file__).parent
app = Flask(__name__)

_lock = threading.Lock()
_running = False


# ── Static files ──────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(BASE, 'index.html')

@app.route('/<path:p>')
def static_file(p):
    return send_from_directory(BASE, p)


# ── Deals API ─────────────────────────────────────────────────────────────────

@app.route('/api/deals')
def get_deals():
    f = BASE / 'deals.json'
    if f.exists():
        return jsonify(json.loads(f.read_text()))
    return jsonify({'deals': [], 'last_updated': None, 'total_coupons_scanned': 0})


@app.route('/api/refresh-deals', methods=['POST'])
def refresh_deals():
    global _running
    with _lock:
        if _running:
            return jsonify({'status': 'running', 'message': 'Scraper already in progress — a browser window should be open.'})
        _running = True

    try:
        import scraper
        result = asyncio.run(scraper.run_scraper())
        return jsonify({'status': 'complete', **result})
    except Exception as e:
        return jsonify({'status': 'error', 'error': str(e), 'detail': traceback.format_exc()}), 500
    finally:
        with _lock:
            _running = False


@app.route('/api/scraper-status')
def scraper_status():
    return jsonify({'running': _running})


# ── Price Check API ───────────────────────────────────────────────────────────

@app.route('/api/price-check/products')
def price_check_products():
    try:
        import price_checker as pc
        products = pc.load_ranked_products(min_purchases=2)
        return jsonify([{
            'item_basic':    p['item_basic'],
            'department':    p['department'],
            'count':         p['count'],
            'avg_price':     p['avg_price'],
            'min_price':     p['min_price'],
            'max_price':     p['max_price'],
            'top_brand':     p['top_brand'],
            'default_size':  pc.extract_size(p['top_full_name']),
        } for p in products[:60]])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/price-check/item', methods=['POST'])
def price_check_item():
    try:
        import price_checker as pc
        data       = request.json or {}
        item_basic = data.get('item_basic', '')
        brand      = data.get('brand', '')
        size       = data.get('size', '')
        avg_price  = float(data.get('avg_price', 0))
        generics   = data.get('generics', True)

        query = ' '.join(p for p in [brand, item_basic, size] if p)

        token          = pc.get_kroger_token()
        ralphs_results = pc.search_kroger(query, token) if token else []
        walmart_results = pc.search_walmart(query)

        if generics and brand:
            generic_q = ' '.join(p for p in [item_basic, size] if p)
            if token:
                extras = pc.search_kroger(generic_q, token)
                seen   = {r['name'] for r in ralphs_results}
                ralphs_results += [r for r in extras if r['name'] not in seen]
            extras = pc.search_walmart(generic_q)
            seen   = {r['name'] for r in walmart_results}
            walmart_results += [r for r in extras if r['name'] not in seen]

        return jsonify({
            'ralphs':    ralphs_results,
            'walmart':   walmart_results,
            'avg_price': avg_price,
            'query':     query,
        })
    except Exception as e:
        return jsonify({'error': str(e), 'detail': traceback.format_exc()}), 500


if __name__ == '__main__':
    import webbrowser
    threading.Timer(1.2, lambda: webbrowser.open('http://localhost:8080')).start()
    print('Grocery Tracker running at http://localhost:8080')
    print('Press Ctrl+C to stop.')
    app.run(port=8080, debug=False, use_reloader=False, threaded=True)
