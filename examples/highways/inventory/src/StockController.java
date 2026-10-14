package shop.inventory;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/inventory")
public class StockController {
    @GetMapping("/{sku}")
    public Stock get(@PathVariable String sku) { return new Stock(sku, 3); }

    @PostMapping("/reserve")
    public void reserve() {}
}
