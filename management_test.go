package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestServePanelResources(t *testing.T) {
	tests := []struct {
		path        string
		contentType string
		contains    string
	}{
		{path: "/v0/resource/plugins/" + pluginID + panelPath, contentType: "text/html", contains: "Antigravity 额度"},
		{path: "/v0/resource/plugins/" + pluginID + "/panel-app.mjs", contentType: "text/javascript", contains: "initialize()"},
		{path: "/panel-logic.mjs", contentType: "text/javascript", contains: "parseQuota"},
	}
	for _, test := range tests {
		response := servePanelResource(managementRequest{Method: "GET", Path: test.path})
		if response.StatusCode != 200 {
			t.Fatalf("GET %s status = %d", test.path, response.StatusCode)
		}
		if !strings.Contains(response.Headers["Content-Type"][0], test.contentType) {
			t.Fatalf("GET %s content type = %q", test.path, response.Headers["Content-Type"])
		}
		if !strings.Contains(string(response.Body), test.contains) {
			t.Fatalf("GET %s response does not contain %q", test.path, test.contains)
		}
		if response.Headers["Content-Security-Policy"][0] == "" {
			t.Fatalf("GET %s missing CSP", test.path)
		}
	}
}

func TestServePanelRejectsUnknownResourceAndMethod(t *testing.T) {
	if response := servePanelResource(managementRequest{Method: "POST", Path: panelPath}); response.StatusCode != 405 {
		t.Fatalf("POST status = %d, want 405", response.StatusCode)
	}
	if response := servePanelResource(managementRequest{Method: "GET", Path: panelPath + "/missing.js"}); response.StatusCode != 404 {
		t.Fatalf("missing resource status = %d, want 404", response.StatusCode)
	}
}

func TestManagementHandleEnvelope(t *testing.T) {
	payload, err := json.Marshal(managementRequest{Method: "GET", Path: panelPath})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := dispatchRPC("management.handle", payload)
	if err != nil {
		t.Fatalf("dispatchRPC() error = %v", err)
	}
	var response envelope
	if err := json.Unmarshal(raw, &response); err != nil || !response.OK {
		t.Fatalf("unexpected envelope: %s, error: %v", raw, err)
	}
	var page managementResponse
	if err := json.Unmarshal(response.Result, &page); err != nil {
		t.Fatalf("decode management response: %v", err)
	}
	if page.StatusCode != 200 || len(page.Body) == 0 {
		t.Fatalf("unexpected page response: status=%d body=%d", page.StatusCode, len(page.Body))
	}
}
