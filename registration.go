package main

import "encoding/json"

func pluginRegistration() any {
	return struct {
		SchemaVersion uint32         `json:"schema_version"`
		Metadata      map[string]any `json:"metadata"`
		Capabilities  map[string]any `json:"capabilities"`
	}{
		SchemaVersion: 1,
		Metadata: map[string]any{
			"Name":             pluginName,
			"Version":          pluginVersion,
			"Author":           pluginAuthor,
			"GitHubRepository": "https://github.com/BlackCatCmx/cpa-plugin-agy-panel",
			"Logo":             "",
			"ConfigFields": []map[string]any{
				{"Name": "proxy_list", "Type": "string", "EnumValues": []string{}, "Description": "Proxy URLs, one per line, assigned cyclically to Antigravity credentials."},
				{"Name": "show_claude_gpt", "Type": "boolean", "EnumValues": []string{}, "Description": "Show Claude and GPT quota groups. Disabled by default."},
			},
		},
		Capabilities: map[string]any{"management_api": true},
	}
}

func managementRegistration() any {
	return struct {
		Resources []map[string]string `json:"resources"`
	}{Resources: []map[string]string{
		{
			"Path":        panelPath,
			"Menu":        "Antigravity 额度",
			"Description": "Antigravity quota and proxy panel",
		},
		{"Path": "/panel-app.mjs"},
		{"Path": "/panel-logic.mjs"},
	}}
}

func okEnvelope(result any) ([]byte, error) {
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{OK: true, Result: raw})
}

func errorEnvelope(code, message string) []byte {
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message}})
	return raw
}
