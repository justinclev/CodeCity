import requests
from flask import Flask

app = Flask(__name__)


@app.route("/legacy/status")
def status():
    return requests.get("http://search:3001/api/search").text
