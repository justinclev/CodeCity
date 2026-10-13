.PHONY: build web test clean dev

build: web
	mkdir -p bin
	go build -o bin/codecity ./cmd/codecity

web:
	cd web && npm install && npm run build
	mkdir -p internal/web/dist
	cp -r web/dist/* internal/web/dist/

test:
	go test ./...

dev:
	cd web && npm run dev

clean:
	rm -rf bin web/dist
	find internal/web/dist -mindepth 1 ! -name .gitkeep -delete

.PHONY: demo
demo: build
	./scripts/demo-highways.sh
