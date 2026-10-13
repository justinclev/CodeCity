use axum::{routing::get, Router};

async fn find() -> String {
    reqwest::get("http://catalog-api:8000/api/catalog/items").await.unwrap().text().await.unwrap()
}

fn app() -> Router {
    Router::new().route("/api/search", get(find))
}

fn main() {}
