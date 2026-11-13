// RoaDo Optimizer launcher: a tiny local web server with the whole app embedded.
// Double-click → serves the app on 127.0.0.1 and opens it in a browser window.
// It exits on its own a couple of minutes after the app window is closed.
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

//go:embed web
var webFS embed.FS

// Fixed port so the browser origin (and the app's saved data in localStorage) stays the same between runs.
const port = "47815"

// How long to keep running after the last heartbeat from an open app window.
const idleTimeout = 150 * time.Second

const heartbeat = `<script>(function(){function p(){fetch('/__ping',{cache:'no-store'}).catch(function(){})}p();setInterval(p,20000);document.addEventListener('visibilitychange',p);})();</script>`

func main() {
	addr := "127.0.0.1:" + port
	url := "http://" + addr + "/"

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		// Already running? Just open another window on it.
		c := http.Client{Timeout: 2 * time.Second}
		if resp, e := c.Get(url + "__ping"); e == nil {
			resp.Body.Close()
			openBrowser(url)
			return
		}
		// Port taken by something else: fall back to a random port (saved data won't carry over).
		if ln, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
			fmt.Fprintln(os.Stderr, "cannot start local server:", err)
			os.Exit(1)
		}
		url = "http://" + ln.Addr().String() + "/"
	}

	web, _ := fs.Sub(webFS, "web")
	var last atomic.Int64
	last.Store(time.Now().Unix())

	mux := http.NewServeMux()
	mux.HandleFunc("/__ping", func(w http.ResponseWriter, r *http.Request) {
		last.Store(time.Now().Unix())
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		last.Store(time.Now().Unix())
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" || p == "." {
			p = "index.html"
		}
		w.Header().Set("Cache-Control", "no-cache")
		if p == "index.html" {
			b, err := fs.ReadFile(web, "index.html")
			if err != nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(strings.Replace(string(b), "</body>", heartbeat+"</body>", 1)))
			return
		}
		// Assets are stored pre-gzipped to keep the executable small.
		b, err := fs.ReadFile(web, p+".gz")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		ct := mime.TypeByExtension(filepath.Ext(p))
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Content-Encoding", "gzip")
		w.Write(b)
	})

	go func() {
		for {
			time.Sleep(10 * time.Second)
			if time.Since(time.Unix(last.Load(), 0)) > idleTimeout {
				os.Exit(0)
			}
		}
	}()

	fmt.Println("RoaDo Optimizer is running at", url)
	fmt.Println("It closes automatically shortly after you close the app window.")
	openBrowser(url)
	if err := http.Serve(ln, mux); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// openBrowser prefers a chromeless "app" window (Edge/Chrome/Chromium), else the default browser.
func openBrowser(url string) {
	switch runtime.GOOS {
	case "windows":
		for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LocalAppData")} {
			for _, rel := range []string{`Microsoft\Edge\Application\msedge.exe`, `Google\Chrome\Application\chrome.exe`} {
				exe := filepath.Join(base, rel)
				if base != "" && exists(exe) && exec.Command(exe, "--app="+url).Start() == nil {
					return
				}
			}
		}
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		for _, app := range []string{"Google Chrome", "Microsoft Edge", "Chromium"} {
			if exists("/Applications/"+app+".app") && exec.Command("open", "-na", app, "--args", "--app="+url).Start() == nil {
				return
			}
		}
		exec.Command("open", url).Start()
	default:
		for _, b := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"} {
			if p, err := exec.LookPath(b); err == nil && exec.Command(p, "--app="+url).Start() == nil {
				return
			}
		}
		exec.Command("xdg-open", url).Start()
	}
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }
