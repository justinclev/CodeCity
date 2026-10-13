package main

import (
	"net/http"

	"github.com/segmentio/kafka-go"
)

func main() {
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, Topic: "payments.completed", GroupID: "mail"})
	_ = r
	http.HandleFunc("/ws", socket)
	http.ListenAndServe(":8081", nil)
}

func socket(w http.ResponseWriter, req *http.Request) {}
