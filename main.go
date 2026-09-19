package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
)

type PreviewMetadata struct {
	ID                      string `json:"id,omitempty"`
	ReleaseTrackName        string `json:"releaseTrackName,omitempty"`
	ReleaseTrackVersionName string `json:"releaseTrackVersionName,omitempty"`
	Active                  bool   `json:"active,omitempty"`
	Canary                  bool   `json:"canary,omitempty"`
}

type ReleaseBuildMetadata struct {
	Notes  string `json:"notes,omitempty"`
	Latest bool   `json:"latest,omitempty"`
}

type Build struct {
	Product                string                `json:"product"`
	Arch                   string                `json:"arch,omitempty"`
	BuildID                string                `json:"buildId"`
	IsGSI                  interface{}           `json:"isGSI"` // can be bool or string "true"/"false"
	ReleaseCandidateName   string                `json:"releaseCandidateName"`
	LicenseText            []string              `json:"licenseText,omitempty"`
	FactoryImageDownloadURL string               `json:"factoryImageDownloadUrl"`
	Target                 string                `json:"target"`
	Version                string                `json:"version,omitempty"`
	VersionName            string                `json:"versionName,omitempty"`
	APILevel               int                   `json:"apiLevel,omitempty"`
	PreviewMetadata        *PreviewMetadata      `json:"previewMetadata,omitempty"`
	ReleaseBuildMetadata   *ReleaseBuildMetadata `json:"releaseBuildMetadata,omitempty"`
}

type BuildsData struct {
	CompatibleBuilds []Build `json:"compatibleBuilds"`
}

func isGSIValue(val interface{}) bool {
	switch v := val.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true")
	default:
		return false
	}
}

func loadBuilds(filePath string) (BuildsData, error) {
	var data BuildsData
	bytes, err := os.ReadFile(filePath)
	if err != nil {
		return data, err
	}
	err = json.Unmarshal(bytes, &data)
	return data, err
}

func main() {
	port := flag.Int("port", 8080, "Port to listen on")
	buildsFile := flag.String("builds", "builds.json", "Path to builds JSON file")
	flag.Parse()

	http.HandleFunc("/api/builds", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		board := strings.TrimSpace(r.URL.Query().Get("board"))
		arch := strings.TrimSpace(r.URL.Query().Get("arch"))

		// If arch is missing, infer default arch for known boards (e.g. tangorpro -> arm64)
		if arch == "" {
			if strings.EqualFold(board, "tangorpro") || strings.Contains(strings.ToLower(board), "arm64") {
				arch = "arm64"
			}
		}

		data, err := loadBuilds(*buildsFile)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to load builds: %v"}`, err), http.StatusInternalServerError)
			return
		}

		var filtered []Build
		for _, b := range data.CompatibleBuilds {
			gsi := isGSIValue(b.IsGSI)

			// Match rule:
			// 1) Product matches requested board (e.g. "tangorpro")
			// 2) OR it is a GSI (isGSI is true) AND its target/arch matches the requested device arch (e.g. "arm64")
			matchProduct := board != "" && strings.EqualFold(b.Product, board)
			
			// Check architecture match for GSIs
			bArch := b.Arch
			if bArch == "" {
				if strings.Contains(strings.ToLower(b.Product), "arm64") || strings.Contains(strings.ToLower(b.Target), "arm64") {
					bArch = "arm64"
				} else if strings.Contains(strings.ToLower(b.Product), "x86_64") || strings.Contains(strings.ToLower(b.Target), "x86_64") {
					bArch = "x86_64"
				}
			}

			matchGSI := gsi && (arch == "" || strings.EqualFold(bArch, arch))

			if matchProduct || matchGSI {
				filtered = append(filtered, b)
			}
		}

		if filtered == nil {
			filtered = []Build{}
		}

		resp := map[string]interface{}{
			"compatibleBuilds": filtered,
			"board":            board,
			"arch":             arch,
		}

		json.NewEncoder(w).Encode(resp)
	})

	// Serve static files from working directory
	fs := http.FileServer(http.Dir("."))
	http.Handle("/", fs)

	addr := fmt.Sprintf(":%d", *port)
	fmt.Printf("AOSP Flash Tool Backend listening on http://localhost%s\n", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
