from fastapi import FastAPI

app = FastAPI()


@app.get("/api/catalog/items")
def items():
    return []


@app.post("/api/catalog/items")
def add_item():
    return {}
