package main

import "encoding/json"

const (
	abiVersion   uint32 = 1
	pluginID            = "cpa-plugin-agy-panel"
	pluginName          = "CPA AGY Panel"
	pluginAuthor        = "BlackCatCmx"
	panelPath           = "/panel"
)

var pluginVersion = "0.1.5"

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type managementRequest struct {
	Method string              `json:"Method"`
	Path   string              `json:"Path"`
	Header map[string][]string `json:"Headers"`
	Query  map[string][]string `json:"Query"`
	Body   []byte              `json:"Body"`
}

type managementResponse struct {
	StatusCode int                 `json:"StatusCode"`
	Headers    map[string][]string `json:"Headers"`
	Body       []byte              `json:"Body"`
}
