package main

import (
	"database/sql"
	"net/http"
)

var db *sql.DB

func main() {
	http.HandleFunc("/internal/orders", list)
	http.ListenAndServe(":8080", nil)
}

func list(w http.ResponseWriter, r *http.Request) {
	db.Exec("INSERT INTO shop_orders (id, total) VALUES ($1, $2)", "o-1", 10)
	publishCreated("o-1")
}
