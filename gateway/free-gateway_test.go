package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestLoadConfigAcceptsKVAndDefaults(t *testing.T) {
	t.Setenv("BACKEND_URL", "http://127.0.0.1:10001")
	t.Setenv("KV_REST_API_URL", "https://example.upstash.io")
	t.Setenv("KV_REST_API_TOKEN", "test-token")
	t.Setenv("UPSTASH_REDIS_REST_URL", "")
	t.Setenv("UPSTASH_REDIS_REST_TOKEN", "")
	t.Setenv("LISTEN_ADDR", "127.0.0.1:8443")
	config, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig returned %v", err)
	}
	if config.maxIPs != 2 || config.backendPath != "/vless" || config.tokenPathPrefix != "/f/" {
		t.Fatalf("unexpected defaults: %+v", config)
	}
}

func TestTokenPathAcceptsOnlyOneOpaqueSegment(t *testing.T) {
	gateway := &gateway{config: config{tokenPathPrefix: "/f/"}}
	token := "abcdefghijklmnopqrstuvwx12345678"
	if got, ok := gateway.tokenForPath("/f/" + token); !ok || got != token {
		t.Fatalf("valid path was rejected: %q %v", got, ok)
	}
	for _, candidate := range []string{"/vless", "/f/short", "/f/" + token + "/other", "/f/invalid%2Ftoken"} {
		if _, ok := gateway.tokenForPath(candidate); ok {
			t.Fatalf("invalid path was accepted: %s", candidate)
		}
	}
}

func TestSourceIPIgnoresForwardedHeaderUnlessPeerIsTrusted(t *testing.T) {
	request := httptest.NewRequest("GET", "http://gateway.example/f/token", nil)
	request.RemoteAddr = "198.51.100.10:44321"
	request.Header.Set("X-Forwarded-For", "203.0.113.7")
	direct := &gateway{config: config{}}
	if ip, ok := direct.sourceIP(request); !ok || ip != "198.51.100.10" {
		t.Fatalf("untrusted peer must use socket IP, got %q %v", ip, ok)
	}

	trusted, err := parseTrustedProxies("198.51.100.0/24")
	if err != nil {
		t.Fatal(err)
	}
	proxied := &gateway{config: config{trustedProxies: trusted}}
	if ip, ok := proxied.sourceIP(request); !ok || ip != "203.0.113.7" {
		t.Fatalf("trusted peer must use forwarded IP, got %q %v", ip, ok)
	}
}

func TestGatewayProxiesWebSocketUpgradeToPrivateVLESSPath(t *testing.T) {
	redis := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var command []any
		if err := json.NewDecoder(request.Body).Decode(&command); err != nil {
			t.Fatal(err)
		}
		if len(command) < 2 || command[0] != "EVAL" {
			t.Fatalf("unexpected Redis command: %#v", command)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"result":[1,1]}`))
	}))
	defer redis.Close()

	backendPath := make(chan string, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		backendPath <- request.URL.Path
		hijacker, ok := writer.(http.Hijacker)
		if !ok {
			t.Fatal("backend writer does not support hijacking")
		}
		connection, buffer, err := hijacker.Hijack()
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		_, _ = buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = buffer.Flush()
		_, _ = io.Copy(io.Discard, buffer)
	}))
	defer backend.Close()

	backendURL, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	config := config{
		backendURL: backendURL, backendPath: "/vless", tokenPathPrefix: "/f/", maxIPs: 2,
		lease: time.Minute, refresh: time.Minute, redisURL: redis.URL, redisToken: "test",
		redisPrefix: "free-web:v1", handshakeRPM: 60,
	}
	proxy := &gateway{
		config: config,
		leases: &leaseStore{config: config, redis: &redisClient{
			endpoint: redis.URL, token: "test", http: &http.Client{Timeout: time.Second},
		}},
		limiter: &handshakeLimiter{entries: make(map[string]rateEntry), limit: 60},
	}
	front := httptest.NewServer(proxy)
	defer front.Close()

	address := strings.TrimPrefix(front.URL, "http://")
	connection, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	token := "abcdefghijklmnopqrstuvwx12345678"
	_, _ = fmt.Fprintf(connection, "GET /f/%s HTTP/1.1\r\nHost: gateway.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", token)
	request, _ := http.NewRequest(http.MethodGet, front.URL+"/f/"+token, nil)
	response, err := http.ReadResponse(bufio.NewReader(connection), request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("expected 101, got %d", response.StatusCode)
	}
	if got := <-backendPath; got != "/vless" {
		t.Fatalf("backend received %q instead of /vless", got)
	}
}
