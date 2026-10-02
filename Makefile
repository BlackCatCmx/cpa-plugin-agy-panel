PLUGIN_ID := cpa-plugin-agy-panel
BUILD_DIR := $(CURDIR)/build
GOOS_VALUE := $(shell go env GOOS)

ifeq ($(GOOS_VALUE),windows)
PLUGIN_EXT := dll
else
PLUGIN_EXT := so
endif

.PHONY: build test verify

build:
	mkdir -p $(BUILD_DIR)
	CGO_ENABLED=1 go build -buildvcs=false -buildmode=c-shared -o $(BUILD_DIR)/$(PLUGIN_ID).$(PLUGIN_EXT) .

test:
	go test ./...
	node --test web-test/*.test.mjs

verify: test build
