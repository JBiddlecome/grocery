import http.server
import socketserver
import webbrowser
import threading
import os

PORT = 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

def open_browser():
    webbrowser.open(f'http://localhost:{PORT}')

threading.Timer(1.0, open_browser).start()

Handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Grocery Tracker running at http://localhost:{PORT}')
    print('Press Ctrl+C to stop.')
    httpd.serve_forever()
