package main

import (
	"embed"
	"fmt"
	"mime"
	"path"
	"strings"
)

//go:embed web/*
var panelFiles embed.FS

var resourceHeaders = map[string][]string{
	"Cache-Control":                {"no-store"},
	"Pragma":                       {"no-cache"},
	"X-Content-Type-Options":       {"nosniff"},
	"Referrer-Policy":              {"no-referrer"},
	"Permissions-Policy":           {"camera=(), microphone=(), geolocation=()"},
	"Cross-Origin-Resource-Policy": {"same-origin"},
	"Content-Security-Policy":      {"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"},
}

func servePanelResource(request managementRequest) managementResponse {
	if request.Method != "GET" {
		return textResponse(405, "method not allowed")
	}

	resourcePath := strings.TrimPrefix(request.Path, "/v0/resource/plugins/"+pluginID)
	if resourcePath == panelPath {
		resourcePath = ""
	}
	resourcePath = strings.TrimPrefix(resourcePath, "/")
	if resourcePath == "" {
		resourcePath = "panel.html"
	}
	if resourcePath != "panel.html" && resourcePath != "panel-app.mjs" && resourcePath != "panel-logic.mjs" {
		return textResponse(404, "not found")
	}

	body, err := panelFiles.ReadFile("web/" + resourcePath)
	if err != nil {
		return textResponse(500, "resource unavailable")
	}
	headers := cloneHeaders(resourceHeaders)
	contentType := mime.TypeByExtension(path.Ext(resourcePath))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if resourcePath == "panel.html" {
		contentType = "text/html; charset=utf-8"
	} else if strings.HasSuffix(resourcePath, ".mjs") {
		contentType = "text/javascript; charset=utf-8"
	}
	headers["Content-Type"] = []string{contentType}
	return managementResponse{StatusCode: 200, Headers: headers, Body: body}
}

func textResponse(status int, message string) managementResponse {
	headers := cloneHeaders(resourceHeaders)
	headers["Content-Type"] = []string{"text/plain; charset=utf-8"}
	return managementResponse{StatusCode: status, Headers: headers, Body: []byte(fmt.Sprintf("%d %s\n", status, message))}
}

func cloneHeaders(source map[string][]string) map[string][]string {
	result := make(map[string][]string, len(source))
	for key, values := range source {
		result[key] = append([]string(nil), values...)
	}
	return result
}
