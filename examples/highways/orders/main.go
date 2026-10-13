package main

import "net/http"

func main() {
	http.HandleFunc("/internal/orders", list)
	http.ListenAndServe(":8080", nil)
}

func list(w http.ResponseWriter, r *http.Request) { publishCreated("o-1") }
