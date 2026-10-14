package messaging

import (
	"sort"
	"testing"
)

func ops(t *testing.T, path, src string, consts map[string]string) []string {
	t.Helper()
	var out []string
	for _, o := range Scan(path, []byte(src), consts) {
		out = append(out, o.Dir+":"+o.Topic)
	}
	sort.Strings(out)
	return out
}

func eq(t *testing.T, got []string, want ...string) {
	t.Helper()
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func TestGoKafka(t *testing.T) {
	src := `package x
import "github.com/segmentio/kafka-go"
const TopicPaid = "orders.paid"
func a() {
	w := &kafka.Writer{Addr: kafka.TCP("b"), Topic: "orders.created"}
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: b, Topic: TopicPaid, GroupID: "g"})
	_ = kafka.Message{Topic: dyn}
}
func b() { c.SubscribeTopics([]string{"a", "b"}, nil); p.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topicX}}, nil) }
`
	eq(t, ops(t, "x.go", src, Consts([]byte(src))), "pub:orders.created", "sub:orders.paid", "sub:a", "sub:b")
}

func TestJSKafka(t *testing.T) {
	src := `import { Kafka } from 'kafkajs'
const TOPICS = { USERS: 'users.signup' }
await producer.send({ topic: 'orders.created', messages: [] })
await consumer.subscribe({ topic: TOPICS.USERS, fromBeginning: true })
await consumer.subscribe({ topics: ['a.b', "c.d"] })
`
	eq(t, ops(t, "x.ts", src, Consts([]byte(src))), "pub:orders.created", "sub:users.signup", "sub:a.b", "sub:c.d")
}

func TestPythonKafka(t *testing.T) {
	src := `from kafka import KafkaProducer, KafkaConsumer
p = KafkaProducer(bootstrap_servers="b")
p.send('orders.created', b'x')
c = KafkaConsumer('orders.paid', bootstrap_servers="b")
c.subscribe(['x.y'])
`
	eq(t, ops(t, "x.py", src, nil), "pub:orders.created", "sub:orders.paid", "sub:x.y")
}

func TestNoKafka(t *testing.T) {
	if len(Scan("x.py", []byte("p.send('x', 1)"), nil)) != 0 {
		t.Fatal("no kafka marker, no ops")
	}
}

func TestOtherBrokers(t *testing.T) {
	var got []string
	for _, o := range Scan("x.go", []byte(`package x
import "github.com/nats-io/nats.go"
func f() { nc.Publish("orders.new", b); nc.Subscribe("orders.paid", h) }
`), nil) {
		got = append(got, o.Broker+":"+o.Dir+":"+o.Topic)
	}
	sort.Strings(got)
	eq(t, got, "nats:pub:orders.new", "nats:sub:orders.paid")
	var js []string
	for _, o := range Scan("x.ts", []byte(`import amqp from 'amqplib'
ch.sendToQueue('jobs', buf); ch.consume('results', cb)
const sqs = new SQSClient({}); await sqs.send(new SendMessageCommand({ QueueUrl: 'https://sqs.x.amazonaws.com/1/emails', MessageBody: 'x' }))
`), nil) {
		js = append(js, o.Broker+":"+o.Dir+":"+o.Topic)
	}
	sort.Strings(js)
	eq(t, js, "amqp:pub:jobs", "amqp:sub:results", "sqs:pub:emails")
}

func TestJvmMessaging(t *testing.T) {
	var got []string
	for _, o := range Scan("A.java", []byte(`class A {
  static final String PAID = "payments.completed";
  @KafkaListener(topics = {"orders.created", PAID}, groupId = "g") void on(String s) {}
  void f() { kafkaTemplate.send("orders.shipped", s); new ProducerRecord<>("orders.audit", k, v); }
  @RabbitListener(queues = "jobs") void j() {}
}`), Consts([]byte(`static final String PAID = "payments.completed";`))) {
		got = append(got, o.Broker+":"+o.Dir+":"+o.Topic)
	}
	sort.Strings(got)
	eq(t, got, "amqp:sub:jobs", "kafka:pub:orders.audit", "kafka:pub:orders.shipped", "kafka:sub:orders.created", "kafka:sub:payments.completed")
	var cs []string
	for _, o := range Scan("P.cs", []byte(`using Confluent.Kafka; await producer.ProduceAsync("orders.created", m); consumer.Subscribe(new[] { "a", "b" });`), nil) {
		cs = append(cs, o.Dir+":"+o.Topic)
	}
	sort.Strings(cs)
	eq(t, cs, "pub:orders.created", "sub:a", "sub:b")
}

func TestAsyncAPI(t *testing.T) {
	v2 := "asyncapi: '2.6.0'\nservers:\n  prod:\n    protocol: kafka\nchannels:\n  orders.created:\n    publish:\n      message: {}\n  payments.completed:\n    subscribe:\n      message: {}\n"
	var got []string
	for _, o := range AsyncAPI("asyncapi.yaml", []byte(v2)) {
		got = append(got, o.Broker+":"+o.Dir+":"+o.Topic)
	}
	sort.Strings(got)
	// v2 "publish" = others publish, this application consumes; "subscribe" = this application publishes
	eq(t, got, "kafka:pub:payments.completed", "kafka:sub:orders.created")
	v3 := "asyncapi: 3.0.0\nservers:\n  prod:\n    protocol: amqp\nchannels:\n  orderChannel:\n    address: orders.new\noperations:\n  sendOrder:\n    action: send\n    channel:\n      $ref: '#/channels/orderChannel'\n"
	got = nil
	for _, o := range AsyncAPI("asyncapi.yml", []byte(v3)) {
		got = append(got, o.Broker+":"+o.Dir+":"+o.Topic)
	}
	eq(t, got, "amqp:pub:orders.new")
}
