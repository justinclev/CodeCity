package main

import (
	"io"
	"net/http"
)

// The gateway serves the public API and forwards to the services behind it.
func main() {
	http.HandleFunc("/api/shop/orders", orders)
	http.HandleFunc("/api/shop/profile", profile)
	http.HandleFunc("/api/shop/partner", partner)
	http.ListenAndServe(":8000", nil)
}

func orders(w http.ResponseWriter, r *http.Request) {
	resp, _ := http.Get("http://orders:8080/internal/orders")
	io.Copy(w, resp.Body)
}

func profile(w http.ResponseWriter, r *http.Request) {
	resp, _ := http.Get("http://users:3000/internal/users/me")
	io.Copy(w, resp.Body)
}

func partner(w http.ResponseWriter, r *http.Request) {
	resp, _ := http.Get("http://partners:9000/partners/42/offers")
	io.Copy(w, resp.Body)
}
