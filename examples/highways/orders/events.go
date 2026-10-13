package main

import (
	"context"

	"github.com/segmentio/kafka-go"
)

const (
	topicCreated = "orders.created"
	topicPaid    = "payments.completed"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topicCreated}

func publishCreated(id string) {
	writer.WriteMessages(context.Background(), kafka.Message{Value: []byte(id)})
}

func watchPayments() {
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, Topic: topicPaid, GroupID: "orders"})
	_ = r
}
