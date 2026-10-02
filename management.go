package main

import (
	"encoding/json"
	"errors"
)

func dispatchRPC(method string, payload []byte) ([]byte, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		return okEnvelope(pluginRegistration())
	case "management.register":
		return okEnvelope(managementRegistration())
	case "management.handle":
		var request managementRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return errorEnvelope("invalid_request", "invalid management request"), errors.New("invalid management request")
		}
		return okEnvelope(servePanelResource(request))
	default:
		return errorEnvelope("unknown_method", "unknown method: "+method), errors.New("unknown method")
	}
}
