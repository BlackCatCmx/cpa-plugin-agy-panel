package main

import (
	"encoding/json"
	"testing"
)

func TestPluginRegistration(t *testing.T) {
	raw, err := dispatchRPC("plugin.register", nil)
	if err != nil {
		t.Fatalf("dispatchRPC() error = %v", err)
	}
	var response envelope
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if !response.OK {
		t.Fatal("plugin.register returned a failed envelope")
	}
	var result struct {
		SchemaVersion uint32 `json:"schema_version"`
		Metadata      struct {
			Name string `json:"Name"`
		} `json:"metadata"`
		Capabilities map[string]bool `json:"capabilities"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatalf("decode registration: %v", err)
	}
	if result.SchemaVersion != 1 || result.Metadata.Name != pluginName || !result.Capabilities["management_api"] {
		t.Fatalf("unexpected registration: %#v", result)
	}
}

func TestManagementRegistration(t *testing.T) {
	raw, err := dispatchRPC("management.register", nil)
	if err != nil {
		t.Fatalf("dispatchRPC() error = %v", err)
	}
	var response envelope
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	var result struct {
		Resources []map[string]string `json:"resources"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatalf("decode management registration: %v", err)
	}
	if len(result.Resources) != 3 || result.Resources[0]["Path"] != panelPath || result.Resources[1]["Path"] != "/panel-app.mjs" {
		t.Fatalf("unexpected resources: %#v", result.Resources)
	}
}
