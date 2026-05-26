from flask import Flask, jsonify, send_from_directory
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


if __name__ == '__main__':
    import webbrowser
    threading.Timer(1.2, lambda: webbrowser.open('http://localhost:8080')).start()
    print('Grocery Tracker running at http://localhost:8080')
    print('Press Ctrl+C to stop.')
    app.run(port=8080, debug=False, use_reloader=False, threaded=True)
