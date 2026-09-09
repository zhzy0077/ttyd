#include <errno.h>
#include <fcntl.h>
#include <libwebsockets.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <zlib.h>

#ifdef _WIN32
#include <direct.h>
#include <io.h>
#ifndef O_BINARY
#define O_BINARY 0
#endif
#define ttyd_mkdir(path) _mkdir(path)
#else
#include <unistd.h>
#ifndef O_BINARY
#define O_BINARY 0
#endif
#define ttyd_mkdir(path) mkdir(path, 0700)
#endif

#include "html.h"
#include "server.h"
#include "utils.h"

#define UPLOAD_DIR "/tmp/ttyd"
#define UPLOAD_MAX (64u * 1024u * 1024u)

enum { AUTH_OK, AUTH_FAIL, AUTH_ERROR };

static char *html_cache = NULL;
static size_t html_cache_len = 0;

static int send_unauthorized(struct lws *wsi, unsigned int code, enum lws_token_indexes header) {
  unsigned char buffer[1024 + LWS_PRE], *p, *end;
  p = buffer + LWS_PRE;
  end = p + sizeof(buffer) - LWS_PRE;

  if (lws_add_http_header_status(wsi, code, &p, end) ||
      lws_add_http_header_by_token(wsi, header, (unsigned char *)"Basic realm=\"ttyd\"", 18, &p, end) ||
      lws_add_http_header_content_length(wsi, 0, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
      lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
    return AUTH_FAIL;

  return lws_http_transaction_completed(wsi) ? AUTH_FAIL : AUTH_ERROR;
}

static int check_auth(struct lws *wsi, struct pss_http *pss) {
  if (server->auth_header != NULL) {
    if (lws_hdr_custom_length(wsi, server->auth_header, strlen(server->auth_header)) > 0) return AUTH_OK;
    return send_unauthorized(wsi, HTTP_STATUS_PROXY_AUTH_REQUIRED, WSI_TOKEN_HTTP_PROXY_AUTHENTICATE);
  }

  if(server->credential != NULL) {
    char buf[256];
    int len = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_AUTHORIZATION);
    if (len >= 7 && strstr(buf, "Basic ")) {
      if (!strcmp(buf + 6, server->credential)) return AUTH_OK;
    }
    return send_unauthorized(wsi, HTTP_STATUS_UNAUTHORIZED, WSI_TOKEN_HTTP_WWW_AUTHENTICATE);
  }

  return AUTH_OK;
}

static bool accept_gzip(struct lws *wsi) {
  char buf[256];
  int len = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_ACCEPT_ENCODING);
  return len > 0 && strstr(buf, "gzip") != NULL;
}

static bool uncompress_html(char **output, size_t *output_len) {
  if (html_cache == NULL || html_cache_len == 0) {
    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    if (inflateInit2(&stream, 16 + 15) != Z_OK) return false;

    html_cache_len = index_html_size;
    html_cache = xmalloc(html_cache_len);

    stream.avail_in = index_html_len;
    stream.avail_out = html_cache_len;
    stream.next_in = (void *)index_html;
    stream.next_out = (void *)html_cache;

    int ret = inflate(&stream, Z_SYNC_FLUSH);
    inflateEnd(&stream);
    if (ret != Z_STREAM_END) {
      free(html_cache);
      html_cache = NULL;
      html_cache_len = 0;
      return false;
    }
  }

  *output = html_cache;
  *output_len = html_cache_len;

  return true;
}

static void pss_buffer_free(struct pss_http *pss) {
  if (pss->buffer != (char *)index_html && pss->buffer != html_cache) free(pss->buffer);
  pss->buffer = pss->ptr = NULL;
  pss->len = 0;
}

static bool path_is(const char *path, const char *want) {
  size_t n = strlen(want);
  return strncmp(path, want, n) == 0 && (path[n] == '\0' || path[n] == '?');
}

static int sanitize_filename(char *name) {
  char *slash = strrchr(name, '/');
  if (slash) memmove(name, slash + 1, strlen(slash + 1) + 1);
  slash = strrchr(name, '\\');
  if (slash) memmove(name, slash + 1, strlen(slash + 1) + 1);
  if (name[0] == '\0' || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return -1;
  for (unsigned char *p = (unsigned char *)name; *p; p++) {
    if (*p < 32 || *p == '"' || *p == ':' || *p == '*' || *p == '?' || *p == '<' || *p == '>' || *p == '|') *p = '_';
  }
  return name[0] == '\0' ? -1 : 0;
}

static void upload_close(struct pss_http *pss, bool keep) {
  if (!pss->upload) return;
  if (pss->fd >= 0) close(pss->fd);
  pss->fd = -1;
  pss->upload = false;
  if (!keep && pss->dest[0]) unlink(pss->dest);
  if (!keep) pss->dest[0] = '\0';
}

static int open_upload_file(char *dest, size_t dest_len, const char *name) {
  if (snprintf(dest, dest_len, "%s/%s", UPLOAD_DIR, name) >= (int)dest_len) return -1;
  int fd = open(dest, O_WRONLY | O_CREAT | O_EXCL | O_BINARY, 0600);
  if (fd >= 0) return fd;
  if (errno != EEXIST) return -1;
  for (int i = 1; i < 1000; i++) {
    if (snprintf(dest, dest_len, "%s/%s.%d", UPLOAD_DIR, name, i) >= (int)dest_len) return -1;
    fd = open(dest, O_WRONLY | O_CREAT | O_EXCL | O_BINARY, 0600);
    if (fd >= 0) return fd;
    if (errno != EEXIST) return -1;
  }
  return -1;
}

static int start_json(struct lws *wsi, struct pss_http *pss, unsigned char *buffer, unsigned char *end,
                      const char *json) {
  unsigned char *p = buffer + LWS_PRE;
  size_t n = strlen(json);
  if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
      lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                                   (unsigned char *)"application/json;charset=utf-8", 30, &p, end) ||
      lws_add_http_header_content_length(wsi, (unsigned long)n, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
      lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
    return 1;
  pss->buffer = pss->ptr = strdup(json);
  pss->len = n;
  lws_callback_on_writable(wsi);
  return 0;
}

static void access_log(struct lws *wsi, const char *path) {
  char rip[50];

  lws_get_peer_simple(lws_get_network_wsi(wsi), rip, sizeof(rip));
  lwsl_notice("HTTP %s - %s\n", path, rip);
}

int callback_http(struct lws *wsi, enum lws_callback_reasons reason, void *user, void *in, size_t len) {
  struct pss_http *pss = (struct pss_http *)user;
  unsigned char buffer[4096 + LWS_PRE], *p, *end;
  char buf[256];
  bool done = false;

  switch (reason) {
    case LWS_CALLBACK_HTTP:
      access_log(wsi, (const char *)in);
      snprintf(pss->path, sizeof(pss->path), "%s", (const char *)in);
      switch (check_auth(wsi, pss)) {
        case AUTH_OK:
          break;
        case AUTH_FAIL:
          return 0;
        case AUTH_ERROR:
        default:
          return 1;
      }

      p = buffer + LWS_PRE;
      end = p + sizeof(buffer) - LWS_PRE;

      if (path_is(pss->path, endpoints.token)) {
        const char *credential = server->credential != NULL ? server->credential : "";
        snprintf(buf, sizeof(buf), "{\"token\": \"%s\"}", credential);
        if (start_json(wsi, pss, buffer, end, buf)) return 1;
        break;
      }

      // redirects `/base-path` to `/base-path/`
      if (strcmp(pss->path, endpoints.parent) == 0) {
        if (lws_add_http_header_status(wsi, HTTP_STATUS_FOUND, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_LOCATION, (unsigned char *)endpoints.index,
                                         (int)strlen(endpoints.index), &p, end) ||
            lws_add_http_header_content_length(wsi, 0, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;
        goto try_to_reuse;
      }

      if (path_is(pss->path, endpoints.upload)) {
        char raw[256], name[256], clen[32];
        const char *arg;
        struct stat st;

        if (lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) <= 0) {
          lws_return_http_status(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL);
          goto try_to_reuse;
        }
        arg = lws_get_urlarg_by_name(wsi, "name=", raw, sizeof(raw));
        if (arg == NULL || arg[0] == '\0') {
          lws_return_http_status(wsi, HTTP_STATUS_BAD_REQUEST, NULL);
          goto try_to_reuse;
        }
        snprintf(name, sizeof(name), "%s", arg);
        if (sanitize_filename(name) < 0) {
          lws_return_http_status(wsi, HTTP_STATUS_BAD_REQUEST, NULL);
          goto try_to_reuse;
        }
        if (lws_hdr_copy(wsi, clen, sizeof(clen), WSI_TOKEN_HTTP_CONTENT_LENGTH) > 0 &&
            strtoul(clen, NULL, 10) > UPLOAD_MAX) {
          lws_return_http_status(wsi, HTTP_STATUS_REQ_ENTITY_TOO_LARGE, NULL);
          goto try_to_reuse;
        }
        if (ttyd_mkdir(UPLOAD_DIR) < 0 && errno != EEXIST) {
          lwsl_err("mkdir %s: %s\n", UPLOAD_DIR, strerror(errno));
          lws_return_http_status(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL);
          goto try_to_reuse;
        }
        if (stat(UPLOAD_DIR, &st) < 0 || !S_ISDIR(st.st_mode)) {
          lws_return_http_status(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL);
          goto try_to_reuse;
        }
        pss->fd = open_upload_file(pss->dest, sizeof(pss->dest), name);
        if (pss->fd < 0) {
          lwsl_err("open upload: %s\n", strerror(errno));
          lws_return_http_status(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL);
          goto try_to_reuse;
        }
        pss->upload = true;
        pss->len = 0;
        break;
      }

      if (strcmp(pss->path, endpoints.index) != 0) {
        lws_return_http_status(wsi, HTTP_STATUS_NOT_FOUND, NULL);
        goto try_to_reuse;
      }

      const char *content_type = "text/html";
      if (server->index != NULL) {
        int n = lws_serve_http_file(wsi, server->index, content_type, NULL, 0);
        if (n < 0 || (n > 0 && lws_http_transaction_completed(wsi))) return 1;
      } else {
        char *output = (char *)index_html;
        size_t output_len = index_html_len;
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE, (const unsigned char *)content_type, 9, &p,
                                         end))
          return 1;
#ifdef LWS_WITH_HTTP_STREAM_COMPRESSION
        if (!uncompress_html(&output, &output_len)) return 1;
#else
        if (accept_gzip(wsi)) {
          if (lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_ENCODING, (unsigned char *)"gzip", 4, &p, end))
            return 1;
        } else {
          if (!uncompress_html(&output, &output_len)) return 1;
        }
#endif

        if (lws_add_http_header_content_length(wsi, (unsigned long)output_len, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;

        pss->buffer = pss->ptr = output;
        pss->len = output_len;
        lws_callback_on_writable(wsi);
      }
      break;

    case LWS_CALLBACK_HTTP_WRITEABLE:
      if (!pss->buffer || pss->len == 0) {
        goto try_to_reuse;
      }

      do {
        int n = sizeof(buffer) - LWS_PRE;
        int m = lws_get_peer_write_allowance(wsi);
        if (m == 0) {
          lws_callback_on_writable(wsi);
          return 0;
        } else if (m != -1 && m < n) {
          n = m;
        }
        if (pss->ptr + n > pss->buffer + pss->len) {
          n = (int)(pss->len - (pss->ptr - pss->buffer));
          done = true;
        }
        memcpy(buffer + LWS_PRE, pss->ptr, n);
        pss->ptr += n;
        if (lws_write_http(wsi, buffer + LWS_PRE, (size_t)n) < n) {
          pss_buffer_free(pss);
          return -1;
        }
      } while (!lws_send_pipe_choked(wsi) && !done);

      if (!done && pss->ptr < pss->buffer + pss->len) {
        lws_callback_on_writable(wsi);
        break;
      }

      pss_buffer_free(pss);
      goto try_to_reuse;

    case LWS_CALLBACK_HTTP_BODY:
      if (!pss || !pss->upload) break;
      if (pss->len + len > UPLOAD_MAX) {
        upload_close(pss, false);
        lws_return_http_status(wsi, HTTP_STATUS_REQ_ENTITY_TOO_LARGE, NULL);
        return 1;
      }
      {
        const char *data = (const char *)in;
        size_t left = len;
        while (left) {
          int n = (int)write(pss->fd, data, left);
          if (n <= 0) {
            upload_close(pss, false);
            lws_return_http_status(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL);
            return 1;
          }
          data += n;
          left -= (size_t)n;
        }
      }
      pss->len += len;
      break;

    case LWS_CALLBACK_HTTP_BODY_COMPLETION:
      if (!pss || !pss->upload) break;
      {
        char json[sizeof(pss->dest) + 16];
        snprintf(json, sizeof(json), "{\"path\":\"%s\"}", pss->dest);
        upload_close(pss, true);
        p = buffer + LWS_PRE;
        end = p + sizeof(buffer) - LWS_PRE;
        if (start_json(wsi, pss, buffer, end, json)) return 1;
        pss->dest[0] = '\0';
      }
      break;

    case LWS_CALLBACK_CLOSED_HTTP:
      if (pss) upload_close(pss, false);
      break;

    case LWS_CALLBACK_HTTP_FILE_COMPLETION:
      goto try_to_reuse;
#if (defined(LWS_OPENSSL_SUPPORT) || defined(LWS_WITH_TLS)) && !defined(LWS_WITH_MBEDTLS)
    case LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION:
      if (!len || (SSL_get_verify_result((SSL *)in) != X509_V_OK)) {
        int err = X509_STORE_CTX_get_error((X509_STORE_CTX *)user);
        int depth = X509_STORE_CTX_get_error_depth((X509_STORE_CTX *)user);
        const char *msg = X509_verify_cert_error_string(err);
        lwsl_err("client certificate verification error: %s (%d), depth: %d\n", msg, err, depth);
        return 1;
      }
      break;
#endif
    default:
      break;
  }

  return 0;

  /* if we're on HTTP1.1 or 2.0, will keep the idle connection alive */
try_to_reuse:
  if (lws_http_transaction_completed(wsi)) return -1;

  return 0;
}
