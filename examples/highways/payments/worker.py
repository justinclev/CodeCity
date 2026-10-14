from kafka import KafkaConsumer, KafkaProducer
import requests

consumer = KafkaConsumer("orders.created", bootstrap_servers="kafka:9092", group_id="payments")
producer = KafkaProducer(bootstrap_servers="kafka:9092")


def run():
    for msg in consumer:
        user = requests.get("http://users:3000/internal/users/me").json()
        producer.send("payments.completed", msg.value)
