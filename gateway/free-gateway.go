// free-gateway is a small WebSocket admission gateway for 3x-ui managed
// VLESS/WS inbounds. It owns no user credentials: Vercel registers opaque
// gateway tokens in Redis, while Xray remains responsible for VLESS auth,
// traffic, expiry, and client lifecycle.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultPrefix       = "free-web:v1"
	defaultTokenPath    = "/f/"
	defaultBackendPath  = "/vless"
	defaultLeaseSeconds = 90
	defaultRefresh      = 20
	defaultHandshakeRPM = 60
	redisTimeout        = 8 * time.Second
)

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)

type config struct {
	listenAddr      string
	backendURL      *url.URL
	backendPath     string
	tokenPathPrefix string
	maxIPs          int
	lease           time.Duration
	refresh         time.Duration
	redisURL        string
	redisToken      string
	redisPrefix     string
	tlsCertFile     string
	tlsKeyFile      string
	trustedProxies  []netip.Prefix
	clientIPHeader  string
	handshakeRPM    int
}

func requiredEnv(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func envInt(name string, fallback, min, max int) (int, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < min || parsed > max {
		return 0, fmt.Errorf("%s must be an integer between %d and %d", name, min, max)
	}
	return parsed, nil
}

func normalizePathPrefix(value string) (string, error) {
	if value == "" {
		return defaultTokenPath, nil
	}
	if !strings.HasPrefix(value, "/") || !strings.HasSuffix(value, "/") || strings.Contains(value, "//") {
		return "", errors.New("GATEWAY_TOKEN_PATH_PREFIX must start and end with one slash")
	}
	return value, nil
}

func parseTrustedProxies(value string) ([]netip.Prefix, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	items := strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' })
	prefixes := make([]netip.Prefix, 0, len(items))
	for _, item := range items {
		prefix, err := netip.ParsePrefix(item)
		if err != nil {
			return nil, fmt.Errorf("invalid trusted proxy CIDR %q", item)
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, nil
}

func loadConfig() (config, error) {
	backend, err := requiredEnv("BACKEND_URL")
	if err != nil {
		return config{}, err
	}
	backendURL, err := url.Parse(backend)
	if err != nil || (backendURL.Scheme != "http" && backendURL.Scheme != "https") || backendURL.Host == "" || backendURL.User != nil || backendURL.RawQuery != "" || backendURL.Fragment != "" {
		return config{}, errors.New("BACKEND_URL must be an absolute HTTP or HTTPS URL without credentials, query, or fragment")
	}
	if backendURL.Path != "" && backendURL.Path != "/" {
		return config{}, errors.New("BACKEND_URL must not include a path; use BACKEND_PATH")
	}
	maxIPs, err := envInt("GATEWAY_MAX_ACTIVE_IPS", 2, 1, 20)
	if err != nil {
		return config{}, err
	}
	leaseSeconds, err := envInt("GATEWAY_LEASE_SECONDS", defaultLeaseSeconds, 30, 900)
	if err != nil {
		return config{}, err
	}
	refreshSeconds, err := envInt("GATEWAY_REFRESH_SECONDS", defaultRefresh, 5, leaseSeconds-1)
	if err != nil {
		return config{}, err
	}
	handshakeRPM, err := envInt("GATEWAY_HANDSHAKE_RPM", defaultHandshakeRPM, 10, 10000)
	if err != nil {
		return config{}, err
	}
	tokenPathPrefix, err := normalizePathPrefix(strings.TrimSpace(os.Getenv("GATEWAY_TOKEN_PATH_PREFIX")))
	if err != nil {
		return config{}, err
	}
	backendPath := strings.TrimSpace(os.Getenv("BACKEND_PATH"))
	if backendPath == "" {
		backendPath = defaultBackendPath
	}
	if !strings.HasPrefix(backendPath, "/") || strings.Contains(backendPath, "//") {
		return config{}, errors.New("BACKEND_PATH must be an absolute path")
	}
	trustedProxies, err := parseTrustedProxies(os.Getenv("TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return config{}, err
	}
	redisURL := strings.TrimSpace(os.Getenv("UPSTASH_REDIS_REST_URL"))
	redisToken := strings.TrimSpace(os.Getenv("UPSTASH_REDIS_REST_TOKEN"))
	if redisURL == "" || redisToken == "" {
		redisURL = strings.TrimSpace(os.Getenv("KV_REST_API_URL"))
		redisToken = strings.TrimSpace(os.Getenv("KV_REST_API_TOKEN"))
	}
	if redisURL == "" || redisToken == "" {
		return config{}, errors.New("UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN is required")
	}
	redisEndpoint, err := url.Parse(redisURL)
	if err != nil || redisEndpoint.Scheme != "https" || redisEndpoint.Host == "" || redisEndpoint.User != nil {
		return config{}, errors.New("Redis REST URL must be an HTTPS URL without credentials")
	}
	redisPrefix := strings.TrimSuffix(strings.TrimSpace(os.Getenv("GATEWAY_REDIS_KEY_PREFIX")), ":")
	if redisPrefix == "" {
		redisPrefix = defaultPrefix
	}
	if !regexp.MustCompile(`^[A-Za-z0-9:_-]{1,128}$`).MatchString(redisPrefix) {
		return config{}, errors.New("GATEWAY_REDIS_KEY_PREFIX contains invalid characters")
	}
	listenAddr := strings.TrimSpace(os.Getenv("LISTEN_ADDR"))
	if listenAddr == "" {
		listenAddr = ":443"
	}
	if _, _, err := net.SplitHostPort(listenAddr); err != nil {
		return config{}, fmt.Errorf("LISTEN_ADDR is invalid: %w", err)
	}
	tlsCertFile := strings.TrimSpace(os.Getenv("TLS_CERT_FILE"))
	tlsKeyFile := strings.TrimSpace(os.Getenv("TLS_KEY_FILE"))
	if (tlsCertFile == "") != (tlsKeyFile == "") {
		return config{}, errors.New("TLS_CERT_FILE and TLS_KEY_FILE must be set together")
	}
	return config{
		listenAddr: listenAddr, backendURL: backendURL, backendPath: path.Clean(backendPath),
		tokenPathPrefix: tokenPathPrefix, maxIPs: maxIPs, lease: time.Duration(leaseSeconds) * time.Second,
		refresh: time.Duration(refreshSeconds) * time.Second, redisURL: redisURL, redisToken: redisToken,
		redisPrefix: redisPrefix, tlsCertFile: tlsCertFile, tlsKeyFile: tlsKeyFile,
		trustedProxies: trustedProxies, clientIPHeader: http.CanonicalHeaderKey(strings.TrimSpace(os.Getenv("CLIENT_IP_HEADER"))),
		handshakeRPM: handshakeRPM,
	}, nil
}

type redisResponse struct {
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

type redisClient struct {
	endpoint string
	token    string
	http     *http.Client
}

func (client *redisClient) eval(ctx context.Context, script string, keys []string, args []string) ([]any, error) {
	parts := make([]any, 0, 3+len(keys)+len(args))
	parts = append(parts, "EVAL", script, len(keys))
	for _, key := range keys {
		parts = append(parts, key)
	}
	for _, arg := range args {
		parts = append(parts, arg)
	}
	body, err := json.Marshal(parts)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.endpoint, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("Redis returned HTTP %d", response.StatusCode)
	}
	var data redisResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&data); err != nil {
		return nil, err
	}
	if data.Error != "" {
		return nil, errors.New("Redis command failed")
	}
	var result []any
	if err := json.Unmarshal(data.Result, &result); err != nil {
		return nil, errors.New("Redis returned an invalid result")
	}
	return result, nil
}

const acquireScript = `
if not redis.call("GET", KEYS[1]) then return {0, 0} end
local now = tonumber(ARGV[1])
local cutoff = now - tonumber(ARGV[2])
local maximum = tonumber(ARGV[3])
local ip = ARGV[4]
local connection = ARGV[5]
local ttl = tonumber(ARGV[6])
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", cutoff)
local known = redis.call("ZSCORE", KEYS[2], ip)
if not known and redis.call("ZCARD", KEYS[2]) >= maximum then return {2, redis.call("ZCARD", KEYS[2])} end
redis.call("ZADD", KEYS[3], now, connection)
redis.call("EXPIRE", KEYS[3], ttl)
redis.call("ZADD", KEYS[2], now, ip)
redis.call("EXPIRE", KEYS[2], ttl)
return {1, redis.call("ZCARD", KEYS[2])}
`

const touchScript = `
if not redis.call("GET", KEYS[1]) then return {0} end
if not redis.call("ZSCORE", KEYS[3], ARGV[3]) then return {0} end
redis.call("ZADD", KEYS[3], ARGV[1], ARGV[3])
redis.call("EXPIRE", KEYS[3], ARGV[4])
redis.call("ZADD", KEYS[2], ARGV[1], ARGV[2])
redis.call("EXPIRE", KEYS[2], ARGV[4])
return {1}
`

const releaseScript = `
redis.call("ZREM", KEYS[3], ARGV[2])
if redis.call("ZCARD", KEYS[3]) == 0 then
  redis.call("DEL", KEYS[3])
  redis.call("ZREM", KEYS[2], ARGV[1])
end
return {1}
`

type leaseStore struct {
	redis  *redisClient
	config config
}

func hashIP(ip string) string {
	digest := sha256.Sum256([]byte(ip))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func randomID(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func (store *leaseStore) keys(token, ip string) []string {
	base := store.config.redisPrefix + ":gateway:"
	return []string{
		base + "token:" + token,
		base + "active:" + token,
		base + "connections:" + token + ":" + hashIP(ip),
	}
}

func number(value any) int {
	number, ok := value.(float64)
	if !ok {
		return 0
	}
	return int(number)
}

func (store *leaseStore) acquire(ctx context.Context, token, ip, connection string) (int, error) {
	now := strconv.FormatInt(time.Now().Unix(), 10)
	result, err := store.redis.eval(ctx, acquireScript, store.keys(token, ip), []string{
		now, strconv.Itoa(int(store.config.lease.Seconds())), strconv.Itoa(store.config.maxIPs), ip, connection,
		strconv.Itoa(int(store.config.lease.Seconds() * 2)),
	})
	if err != nil || len(result) < 1 {
		return 0, err
	}
	return number(result[0]), nil
}

func (store *leaseStore) touch(ctx context.Context, token, ip, connection string) (bool, error) {
	result, err := store.redis.eval(ctx, touchScript, store.keys(token, ip), []string{
		strconv.FormatInt(time.Now().Unix(), 10), ip, connection, strconv.Itoa(int(store.config.lease.Seconds() * 2)),
	})
	if err != nil {
		return false, err
	}
	return len(result) > 0 && number(result[0]) == 1, nil
}

func (store *leaseStore) release(token, ip, connection string) {
	releaseContext, cancel := context.WithTimeout(context.Background(), redisTimeout)
	defer cancel()
	_, _ = store.redis.eval(releaseContext, releaseScript, store.keys(token, ip), []string{ip, connection})
}

type rateEntry struct {
	window time.Time
	count  int
}

type handshakeLimiter struct {
	mu      sync.Mutex
	entries map[string]rateEntry
	limit   int
}

func (limiter *handshakeLimiter) allow(ip string) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := time.Now()
	entry := limiter.entries[ip]
	if entry.window.IsZero() || now.Sub(entry.window) >= time.Minute {
		entry = rateEntry{window: now}
	}
	entry.count++
	limiter.entries[ip] = entry
	if len(limiter.entries) > 100000 {
		for key, item := range limiter.entries {
			if now.Sub(item.window) > 2*time.Minute {
				delete(limiter.entries, key)
			}
		}
	}
	return entry.count <= limiter.limit
}

type gateway struct {
	config  config
	leases  *leaseStore
	limiter *handshakeLimiter
	dialer  net.Dialer
}

func headerHasToken(value, expected string) bool {
	for _, item := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(item), expected) {
			return true
		}
	}
	return false
}

func (gateway *gateway) tokenForPath(value string) (string, bool) {
	if !strings.HasPrefix(value, gateway.config.tokenPathPrefix) {
		return "", false
	}
	token := strings.TrimPrefix(value, gateway.config.tokenPathPrefix)
	if !tokenPattern.MatchString(token) || strings.Contains(token, "/") {
		return "", false
	}
	return token, true
}

func (gateway *gateway) isTrustedProxy(address netip.Addr) bool {
	for _, prefix := range gateway.config.trustedProxies {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func parseForwardedIP(value string) (string, bool) {
	for _, item := range strings.Split(value, ",") {
		candidate := strings.TrimSpace(item)
		if address, err := netip.ParseAddr(candidate); err == nil {
			return address.Unmap().String(), true
		}
	}
	return "", false
}

func (gateway *gateway) sourceIP(request *http.Request) (string, bool) {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return "", false
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return "", false
	}
	address = address.Unmap()
	if !gateway.isTrustedProxy(address) {
		return address.String(), true
	}
	if gateway.config.clientIPHeader != "" {
		if ip, ok := parseForwardedIP(request.Header.Get(gateway.config.clientIPHeader)); ok {
			return ip, true
		}
	}
	return parseForwardedIP(request.Header.Get("X-Forwarded-For"))
}

func gatewayError(writer http.ResponseWriter, status int) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	http.Error(writer, http.StatusText(status), status)
}

func writeRawError(writer *bufio.ReadWriter, status int) {
	fmt.Fprintf(writer, "HTTP/1.1 %d %s\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n", status, http.StatusText(status))
	_ = writer.Flush()
}

func writeResponseHead(writer *bufio.ReadWriter, response *http.Response) error {
	if _, err := fmt.Fprintf(writer, "HTTP/%d.%d %s\r\n", response.ProtoMajor, response.ProtoMinor, response.Status); err != nil {
		return err
	}
	for key, values := range response.Header {
		for _, value := range values {
			if _, err := fmt.Fprintf(writer, "%s: %s\r\n", key, value); err != nil {
				return err
			}
		}
	}
	if _, err := writer.WriteString("\r\n"); err != nil {
		return err
	}
	return writer.Flush()
}

func (gateway *gateway) dialBackend(ctx context.Context) (net.Conn, error) {
	address := gateway.config.backendURL.Host
	if _, _, err := net.SplitHostPort(address); err != nil {
		if gateway.config.backendURL.Scheme == "https" {
			address = net.JoinHostPort(gateway.config.backendURL.Hostname(), "443")
		} else {
			address = net.JoinHostPort(gateway.config.backendURL.Hostname(), "80")
		}
	}
	connection, err := gateway.dialer.DialContext(ctx, "tcp", address)
	if err != nil || gateway.config.backendURL.Scheme != "https" {
		return connection, err
	}
	tlsConnection := tls.Client(connection, &tls.Config{ServerName: gateway.config.backendURL.Hostname(), MinVersion: tls.VersionTLS12})
	if err := tlsConnection.HandshakeContext(ctx); err != nil {
		connection.Close()
		return nil, err
	}
	return tlsConnection, nil
}

func (gateway *gateway) backendRequest(request *http.Request, sourceIP string) *http.Request {
	copy := request.Clone(context.Background())
	copy.URL = &url.URL{
		Scheme:   gateway.config.backendURL.Scheme,
		Host:     gateway.config.backendURL.Host,
		Path:     gateway.config.backendPath,
		RawPath:  gateway.config.backendPath,
		RawQuery: request.URL.RawQuery,
	}
	copy.RequestURI = ""
	copy.Host = request.Host
	if copy.Host == "" {
		copy.Host = gateway.config.backendURL.Host
	}
	copy.Header = request.Header.Clone()
	copy.Header.Set("X-Real-IP", sourceIP)
	copy.Header.Set("X-Forwarded-For", sourceIP)
	copy.Body = nil
	copy.GetBody = nil
	copy.ContentLength = 0
	return copy
}

func (gateway *gateway) serveUpgrade(writer http.ResponseWriter, request *http.Request, token, sourceIP string) {
	connectionID, err := randomID(18)
	if err != nil {
		gatewayError(writer, http.StatusServiceUnavailable)
		return
	}
	admissionContext, cancel := context.WithTimeout(request.Context(), redisTimeout)
	state, err := gateway.leases.acquire(admissionContext, token, sourceIP, connectionID)
	cancel()
	if err != nil {
		log.Printf("gateway admission store unavailable: %v", err)
		gatewayError(writer, http.StatusServiceUnavailable)
		return
	}
	if state == 0 {
		gatewayError(writer, http.StatusNotFound)
		return
	}
	if state != 1 {
		gatewayError(writer, http.StatusTooManyRequests)
		return
	}
	admitted := true
	defer func() {
		if admitted {
			gateway.leases.release(token, sourceIP, connectionID)
		}
	}()

	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		gatewayError(writer, http.StatusInternalServerError)
		return
	}
	client, clientBuffer, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	backendContext, backendCancel := context.WithTimeout(request.Context(), 10*time.Second)
	backend, err := gateway.dialBackend(backendContext)
	backendCancel()
	if err != nil {
		writeRawError(clientBuffer, http.StatusBadGateway)
		return
	}
	defer backend.Close()
	if err := gateway.backendRequest(request, sourceIP).Write(backend); err != nil {
		writeRawError(clientBuffer, http.StatusBadGateway)
		return
	}
	backendBuffer := bufio.NewReader(backend)
	response, err := http.ReadResponse(backendBuffer, request)
	if err != nil {
		writeRawError(clientBuffer, http.StatusBadGateway)
		return
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		defer response.Body.Close()
		_ = response.Write(clientBuffer)
		_ = clientBuffer.Flush()
		return
	}
	if err := writeResponseHead(clientBuffer, response); err != nil {
		return
	}

	var closeOnce sync.Once
	closeConnections := func() {
		closeOnce.Do(func() {
			_ = client.Close()
			_ = backend.Close()
		})
	}
	stopRefresh := make(chan struct{})
	defer close(stopRefresh)
	go func() {
		ticker := time.NewTicker(gateway.config.refresh)
		defer ticker.Stop()
		lastLeaseConfirmation := time.Now()
		for {
			select {
			case <-stopRefresh:
				return
			case <-ticker.C:
				refreshContext, refreshCancel := context.WithTimeout(context.Background(), redisTimeout)
				valid, refreshErr := gateway.leases.touch(refreshContext, token, sourceIP, connectionID)
				refreshCancel()
				if refreshErr != nil {
					if time.Since(lastLeaseConfirmation) < gateway.config.lease {
						continue
					}
					closeConnections()
					return
				}
				if !valid {
					closeConnections()
					return
				}
				lastLeaseConfirmation = time.Now()
			}
		}
	}()

	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(backend, clientBuffer); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, backendBuffer); done <- struct{}{} }()
	<-done
	closeConnections()
	<-done
}

func (gateway *gateway) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path == "/healthz" && request.Method == http.MethodGet {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"ok":true}`))
		return
	}
	if request.Method != http.MethodGet || !headerHasToken(request.Header.Get("Connection"), "upgrade") || !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
		gatewayError(writer, http.StatusNotFound)
		return
	}
	token, ok := gateway.tokenForPath(request.URL.EscapedPath())
	if !ok {
		gatewayError(writer, http.StatusNotFound)
		return
	}
	sourceIP, ok := gateway.sourceIP(request)
	if !ok || !gateway.limiter.allow(sourceIP) {
		gatewayError(writer, http.StatusTooManyRequests)
		return
	}
	gateway.serveUpgrade(writer, request, token, sourceIP)
}

func main() {
	config, err := loadConfig()
	if err != nil {
		log.Fatalf("invalid configuration: %v", err)
	}
	store := &leaseStore{
		redis:  &redisClient{endpoint: config.redisURL, token: config.redisToken, http: &http.Client{Timeout: redisTimeout}},
		config: config,
	}
	server := &http.Server{
		Addr:              config.listenAddr,
		Handler:           &gateway{config: config, leases: store, limiter: &handshakeLimiter{entries: make(map[string]rateEntry), limit: config.handshakeRPM}},
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       0,
		MaxHeaderBytes:    16 << 10,
	}
	stop, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	go func() {
		<-stop.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("free-gateway listening on %s and forwarding WebSocket requests to %s%s", config.listenAddr, config.backendURL, config.backendPath)
	var serveErr error
	if config.tlsCertFile != "" {
		serveErr = server.ListenAndServeTLS(config.tlsCertFile, config.tlsKeyFile)
	} else {
		serveErr = server.ListenAndServe()
	}
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		log.Fatalf("server failed: %v", serveErr)
	}
}
