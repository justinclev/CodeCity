package main

import (
	"database/sql"
	"net/http"
)

var db *sql.DB

func main() {
	http.HandleFunc("/api/reports", report)
	http.ListenAndServe(":8090", nil)
}

func report(w http.ResponseWriter, r *http.Request) {
	rows, _ := db.Query("SELECT id, total FROM shop_orders WHERE day = $1", "today")
	_ = rows
}
