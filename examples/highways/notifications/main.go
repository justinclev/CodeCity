package main

import "github.com/segmentio/kafka-go"

func main() {
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, Topic: "payments.completed", GroupID: "mail"})
	_ = r
}
