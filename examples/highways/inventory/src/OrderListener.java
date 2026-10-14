package shop.inventory;

import org.springframework.kafka.annotation.KafkaListener;

public class OrderListener {
    static final String ORDERS_CREATED = "orders.created";

    @KafkaListener(topics = ORDERS_CREATED, groupId = "inventory")
    public void onOrder(String payload) {}
}
