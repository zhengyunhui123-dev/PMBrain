#!/usr/bin/env python3
"""Drive PMBrain's real Electron shell, Admin UI, PGLite and MCP boundary.

This is deliberately not a source-shape test. It builds the current Admin and
Desktop renderer, launches Electron with an isolated PMBRAIN_HOME, clicks the
same controls as a user, and verifies results through the visible UI and the
public MCP HTTP endpoint.

Generated databases, documents, screenshots and logs stay under the ignored
``备份/核心用户路径测试`` directory unless --artifacts-dir is supplied.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

from playwright.sync_api import Page, Playwright, TimeoutError as PlaywrightTimeoutError, sync_playwright
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


def configure_utf8_output() -> None:
    """Keep Windows CI diagnostics from crashing on Chinese page titles."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")


configure_utf8_output()


REPO_ROOT = Path(__file__).resolve().parents[2]
DESKTOP_ROOT = REPO_ROOT / "desktop"
ELECTRON_EXE = DESKTOP_ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
DESKTOP_ENTRY = DESKTOP_ROOT / "out" / "main" / "index.js"
DESKTOP_RENDERER = DESKTOP_ROOT / "out" / "renderer" / "index.html"
PACKAGED_EXE = DESKTOP_ROOT / "dist" / "win-unpacked" / "PMBrain.exe"
DEFAULT_ARTIFACTS_ROOT = REPO_ROOT / "备份" / "核心用户路径测试" / "runs"
UNIQUE_MARKER = "pmbrain-real-e2e-orchid-7429"
FIRST_SETUP_TIMEOUT_MS = 300_000


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class LocalOpenAIHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def _json(self, status: int, body: object) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in {"/models", "/v1/models"}:
            self._json(200, {
                "object": "list",
                "data": [
                    {"id": "e2e-chat", "object": "model"},
                    {"id": "e2e-embedding-8", "object": "model"},
                    {"id": "e2e-embedding-12", "object": "model"},
                ],
            })
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        route = self.path.rstrip("/")
        if route in {"/embeddings", "/v1/embeddings"}:
            model = str(body.get("model", ""))
            dimensions = 12 if model.endswith("-12") else 8
            inputs = body.get("input", [""])
            if not isinstance(inputs, list):
                inputs = [inputs]
            data = []
            for index, value in enumerate(inputs):
                seed = (sum(str(value).encode("utf-8")) % 97) / 100.0
                vector = [seed + ((index + offset) % 7) / 100.0 for offset in range(dimensions)]
                data.append({"object": "embedding", "index": index, "embedding": vector})
            self._json(200, {"object": "list", "model": model, "data": data, "usage": {"prompt_tokens": 1, "total_tokens": 1}})
            return
        if route in {"/chat/completions", "/v1/chat/completions"}:
            self._json(200, {
                "id": "chatcmpl-pmbrain-e2e",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": body.get("model", "e2e-chat"),
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "PMBrain E2E response"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })
            return
        self._json(404, {"error": "not_found"})


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address) -> None:  # type: ignore[no-untyped-def]
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class LocalOpenAIServer:
    def __init__(self) -> None:
        self.port = free_port()
        self.server = QuietThreadingHTTPServer(("127.0.0.1", self.port), LocalOpenAIHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def __enter__(self) -> "LocalOpenAIServer":
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def run_checked(command: list[str], cwd: Path) -> None:
    print(f"[build] {cwd}> {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def build_current_source(*, packaged: bool = False) -> None:
    run_checked(["bun", "run", "build:admin"], REPO_ROOT)
    run_checked(["bun", "run", "build"], DESKTOP_ROOT)
    if not packaged:
        return
    env = os.environ.copy()
    env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
    run_checked(["bun", "run", "build:sidecar"], DESKTOP_ROOT)
    print(f"[build] {DESKTOP_ROOT}> bun run build:dir", flush=True)
    subprocess.run(["bun", "run", "build:dir"], cwd=DESKTOP_ROOT, check=True, env=env)
    if not PACKAGED_EXE.exists():
        raise RuntimeError(f"Packaged Desktop is missing: {PACKAGED_EXE}")


def write_fixtures(fixtures: Path) -> tuple[Path, Path]:
    fixtures.mkdir(parents=True, exist_ok=True)
    markdown = fixtures / "real-user-journey.md"
    markdown.write_text(
        "---\ntitle: Real User Journey Orchid\ntags: [e2e]\n---\n\n"
        f"# Real User Journey Orchid\n\nThe searchable marker is {UNIQUE_MARKER}.\n",
        encoding="utf-8",
    )
    pdf = fixtures / "real-user-journey.pdf"
    pdf_canvas = canvas.Canvas(str(pdf), pagesize=letter)
    pdf_canvas.setTitle("PMBrain Real User Journey PDF")
    pdf_canvas.drawString(72, 720, "PMBrain real PDF import journey")
    pdf_canvas.drawString(72, 700, f"Search marker: {UNIQUE_MARKER}-pdf")
    pdf_canvas.save()
    return markdown, pdf


class DesktopSession:
    def __init__(
        self,
        playwright: Playwright,
        artifacts: Path,
        home: Path,
        *,
        executable: Path = ELECTRON_EXE,
        application: Path | None = DESKTOP_ROOT,
        cdp_port: int | None = None,
    ) -> None:
        self.playwright = playwright
        self.artifacts = artifacts
        self.home = home
        self.executable = executable
        self.application = application
        self.cdp_port = cdp_port or free_port()
        self.process: subprocess.Popen[str] | None = None
        self.browser = None
        self.page: Page | None = None

    def start(self) -> Page:
        packaged = self.application is None
        if packaged:
            if not Path(self.executable).exists():
                raise RuntimeError(f"Packaged Desktop is missing: {self.executable}")
        elif not ELECTRON_EXE.exists() or not DESKTOP_ENTRY.exists():
            raise RuntimeError("Desktop build is missing; run without --skip-build first")
        user_data = self.home / "electron-user-data"
        user_data.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["PMBRAIN_HOME"] = str(self.home)
        env["PMBRAIN_E2E"] = "1"
        env["PMBRAIN_E2E_REMOTE_DEBUGGING_PORT"] = str(self.cdp_port)
        stdout = (self.artifacts / "electron.stdout.log").open("a", encoding="utf-8")
        stderr = (self.artifacts / "electron.stderr.log").open("a", encoding="utf-8")
        command = [
            str(self.executable),
            f"--remote-debugging-port={self.cdp_port}",
            f"--user-data-dir={user_data}",
        ]
        if self.application is not None:
            command.append(str(self.application))
        self.process = subprocess.Popen(command, cwd=REPO_ROOT, env=env, stdout=stdout, stderr=stderr, text=True)
        endpoint = f"http://127.0.0.1:{self.cdp_port}"
        last_error: Exception | None = None
        for _ in range(90):
            if self.process.poll() is not None:
                raise RuntimeError(f"Electron exited before CDP became ready (code {self.process.returncode})")
            try:
                with urlopen(f"{endpoint}/json/version", timeout=1) as response:
                    if response.status == 200:
                        self.browser = self.playwright.chromium.connect_over_cdp(endpoint, timeout=10_000)
                        pages = [page for context in self.browser.contexts for page in context.pages]
                        if pages:
                            self.page = pages[0]
                            self.page.set_default_timeout(45_000)
                            browser_log = self.artifacts / "browser.log"
                            self.page.on("console", lambda message: browser_log.open("a", encoding="utf-8").write(f"console[{message.type}] {message.text}\n"))
                            self.page.on("pageerror", lambda error: browser_log.open("a", encoding="utf-8").write(f"pageerror {error}\n"))
                            self.page.on("requestfailed", lambda request: browser_log.open("a", encoding="utf-8").write(f"requestfailed {request.method} {request.url} {request.failure}\n"))
                            self.page.wait_for_load_state("domcontentloaded")
                            return self.page
            except Exception as error:  # readiness polling
                last_error = error
                time.sleep(0.5)
        raise RuntimeError(f"Electron CDP did not become ready: {last_error}")

    def stop(self) -> None:
        if self.page is not None:
            try:
                if self.page.url.startswith("http"):
                    self.page.goto(DESKTOP_RENDERER.as_uri(), wait_until="domcontentloaded", timeout=10_000)
                self.page.evaluate("window.pmbrainDesktop?.quit()")
            except Exception:
                pass
        if self.process is not None:
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=10)
        if self.browser is not None:
            try:
                self.browser.close()
            except Exception:
                pass


def select_custom_model(page: Page, kind: str, base_url: str, model: str) -> None:
    page.locator(f"#add-custom-{kind}-model").click()
    page.locator("#custom-provider-name").fill("PMBrain E2E Local Provider")
    page.locator("#custom-provider-base-url").fill(base_url)
    page.locator("#custom-provider-model-id").fill(model)
    page.locator("#custom-provider-confirm").click()
    page.locator("#custom-provider-dialog").wait_for(state="hidden")


def open_admin_from_desktop(page: Page) -> str:
    if "/admin/" in page.url:
        origin = page.url.split("/admin", 1)[0]
        page.goto(origin + "/admin/#")
    else:
        page.wait_for_function("() => !document.querySelector('#open-admin')?.disabled", timeout=120_000)
        try:
            page.locator("#open-admin").click(timeout=20_000)
        except PlaywrightTimeoutError:
            if "/admin/" not in page.url:
                raise
    page.wait_for_load_state("domcontentloaded")
    page.get_by_role("heading", name="总体概览").wait_for(timeout=90_000)
    return page.url.split("/admin", 1)[0]


def first_launch_journey(page: Page, artifacts: Path, provider: LocalOpenAIServer) -> tuple[str, str]:
    print("[journey 1/6] fresh Desktop launch -> PGLite -> models -> Admin homepage", flush=True)
    database_path = artifacts / "user-home" / "database" / "brain.pglite"
    knowledge_dir = artifacts / "knowledge-source"
    knowledge_dir.mkdir(parents=True, exist_ok=True)
    page.locator("#panel-basic").wait_for(state="visible")
    if "FIRST RUN" not in page.locator("#page-eyebrow").inner_text():
        raise AssertionError("Desktop did not present the first-run setup screen")
    page.locator("#database-path").fill(str(database_path))
    page.locator("#knowledge-directory").fill(str(knowledge_dir))
    page.locator("#next-models").click()
    page.locator("#panel-models").wait_for(state="visible")
    select_custom_model(page, "chat", provider.base_url, "e2e-chat")
    select_custom_model(page, "embedding", provider.base_url, "e2e-embedding-8")
    page.locator("#save-setup").click()
    try:
        page.wait_for_function(
            """() => {
              const wait = document.querySelector('#setup-wait');
              const error = document.querySelector('#global-error');
              return Boolean(wait?.hidden || !error?.hidden);
            }""",
            timeout=FIRST_SETUP_TIMEOUT_MS,
        )
    except PlaywrightTimeoutError:
        progress = {
            "stage": page.locator("#setup-wait-stage").inner_text() if page.locator("#setup-wait-stage").count() else "n/a",
            "title": page.locator("#setup-wait-title").inner_text() if page.locator("#setup-wait-title").count() else "n/a",
            "message": page.locator("#setup-wait-message").inner_text() if page.locator("#setup-wait-message").count() else "n/a",
            "error": page.locator("#global-error").inner_text() if page.locator("#global-error").count() else "n/a",
        }
        (artifacts / "first-launch-timeout.txt").write_text(
            f"url={page.url}\n{json.dumps(progress, ensure_ascii=False, indent=2)}\n",
            encoding="utf-8",
        )
        raise
    if page.locator("#global-error").is_visible():
        raise AssertionError(page.locator("#global-error").inner_text())
    page.locator("#global-success").wait_for(state="visible", timeout=FIRST_SETUP_TIMEOUT_MS)
    success = page.locator("#global-success").inner_text()
    if "配置完成" not in success:
        raise AssertionError(f"First-run setup did not complete: {success}")
    desktop_url = page.url
    return open_admin_from_desktop(page), desktop_url


def import_search_journey(page: Page, origin: str, markdown: Path, pdf: Path, artifacts: Path) -> None:
    print("[journey 2/6] import Markdown/PDF -> visible knowledge -> keyword search", flush=True)
    response = page.goto(origin + "/admin/#import")
    print(f"[admin] import url={page.url} status={response.status if response else 'n/a'} title={page.title()}", flush=True)
    page.get_by_role("heading", name="知识工作台").wait_for()
    page.get_by_label("选择本地文件").set_input_files([str(markdown), str(pdf)])
    page.get_by_role("button", name="导入", exact=True).click()
    try:
        page.wait_for_function(
            """() => {
              const progress = document.querySelector('.assistant-attachment-help')?.textContent || '';
              if (progress.startsWith('正在导入')) return false;
              const pills = Array.from(document.querySelectorAll('.nl-result .run-pill'));
              const last = pills.at(-1);
              if (!last) return false;
              return ['已完成', '失败', '部分完成'].includes((last.textContent || '').trim());
            }""",
            timeout=240_000,
        )
    except PlaywrightTimeoutError:
        details = page.locator(".nl-details")
        if details.count():
            details.evaluate("element => { element.open = true; }")
        diagnostic = page.locator(".nl-result").inner_text() if page.locator(".nl-result").count() else page.locator("body").inner_text()
        (artifacts / "import-run-timeout.txt").write_text(
            f"url={page.url}\nprogress={page.locator('.assistant-attachment-help').inner_text() if page.locator('.assistant-attachment-help').count() else 'n/a'}\n\n{diagnostic}\n",
            encoding="utf-8",
        )
        raise
    textarea = page.locator(".assistant-composer textarea")
    textarea.fill(UNIQUE_MARKER)
    if page.locator(".pm-error-text").count() and page.locator(".pm-error-text").first.is_visible():
        raise AssertionError(f"Import UI reported an error: {page.locator('.pm-error-text').first.inner_text()}")
    run_pill = page.locator(".nl-result .run-pill").last
    if not run_pill.count() or run_pill.inner_text().strip() != "已完成":
        details = page.locator(".nl-result").inner_text()
        raise AssertionError(f"Markdown/PDF import was not fully successful: {details}")
    page.locator(".search-action-main").click()
    result = page.locator(".knowledge-search-result")
    result.wait_for(state="visible", timeout=90_000)
    if UNIQUE_MARKER not in result.inner_text():
        raise AssertionError("Imported Markdown was not returned by the visible keyword search")


def delete_restore_journey(page: Page, origin: str) -> None:
    print("[journey 3/6] delete -> recycle bin -> restore", flush=True)
    page.goto(origin + "/admin/#data")
    page.get_by_role("heading", name="知识数据").wait_for()
    search = page.get_by_placeholder("搜索 slug 或标题")
    search.fill("Real User Journey Orchid")
    row = page.get_by_role("row", name=re.compile("Real User Journey Orchid"))
    row.wait_for(timeout=90_000)
    row.click()
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="移出知识库").click()
    page.get_by_role("button", name="回收站", exact=True).click()
    search = page.get_by_placeholder("搜索 slug 或标题")
    search.fill("Real User Journey Orchid")
    trash_row = page.get_by_role("row", name=re.compile("Real User Journey Orchid"))
    trash_row.wait_for(timeout=90_000)
    trash_row.click()
    page.get_by_role("button", name="撤销删除").click()
    page.get_by_role("button", name="全部", exact=True).click()
    page.get_by_placeholder("搜索 slug 或标题").fill("Real User Journey Orchid")
    page.get_by_role("row", name=re.compile("Real User Journey Orchid")).wait_for(timeout=90_000)


def embedding_switch_journey(
    page: Page,
    artifacts: Path,
    provider: LocalOpenAIServer,
    desktop_url: str | None = None,
) -> None:
    print("[journey 4/6] change embedding model -> dimension migration -> re-embed", flush=True)
    page.goto(desktop_url or DESKTOP_RENDERER.as_uri())
    page.locator("#panel-basic").wait_for(state="visible")
    page.locator('.rail-item[data-target="models"]').click()
    page.wait_for_function(
        "() => Array.from(document.querySelector('#embedding-provider')?.options ?? []).some(option => option.textContent === 'PMBrain E2E Local Provider')"
    )
    # The renderer exposes saved custom endpoints as their generated catalog
    # ids. `custom-openai` is the normalized config provider, not a selectable
    # value in the UI.
    page.locator("#embedding-provider").select_option(label="PMBrain E2E Local Provider")
    page.locator("#embedding-model-name").fill("e2e-embedding-12")
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("#save-setup").click()
    page.locator("#setup-wait").wait_for(state="hidden", timeout=180_000)
    page.locator("#global-success").wait_for(state="visible", timeout=180_000)
    config_path = artifacts / "user-home" / ".pmbrain" / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config.get("embedding_model") != "custom-openai:e2e-embedding-12":
        raise AssertionError("Embedding model change was not persisted")
    if config.get("embedding_dimensions") != 12:
        raise AssertionError(f"Expected a 12-dimensional embedding column, got {config.get('embedding_dimensions')}")
    if page.locator("#global-error").is_visible():
        raise AssertionError(page.locator("#global-error").inner_text())
    origin = open_admin_from_desktop(page)
    page.goto(origin + "/admin/#tasks")
    page.get_by_role("heading", name="任务中心").wait_for(timeout=90_000)
    poll_deadline = time.monotonic() + 180
    rebuild_id = None
    last_runs_response: object = None
    while time.monotonic() < poll_deadline:
        try:
            last_runs_response = page.evaluate(
                """async () => {
                  const controller = new AbortController();
                  const timeout = setTimeout(() => controller.abort(), 5000);
                  try {
                    const response = await fetch('/admin/api/runs', {
                      credentials: 'same-origin',
                      signal: controller.signal,
                    });
                    let body = null;
                    try { body = await response.json(); } catch (_) {}
                    return { ok: response.ok, status: response.status, body };
                  } catch (error) {
                    return { ok: false, status: 0, error: String(error) };
                  } finally {
                    clearTimeout(timeout);
                  }
                }"""
            )
            rows = (last_runs_response or {}).get("body", {}).get("rows", [])
            current = [
                run for run in rows
                if run.get("kind") == "embed_stale"
                and "--catch-up" in (run.get("command") or [])
                and isinstance(run.get("id"), str)
            ]
            current.sort(key=lambda run: str(run.get("startedAt", "")), reverse=True)
            if current:
                rebuild_id = current[0]["id"]
                break
        except Exception as exc:
            last_runs_response = {"error": repr(exc)}
        page.wait_for_timeout(1000)
    if not isinstance(rebuild_id, str) or not rebuild_id:
        raise AssertionError(
            f"Background embedding rebuild was not submitted: {rebuild_id}; "
            f"last runs response={last_runs_response}"
        )
    poll_deadline = time.monotonic() + 180
    rebuild: object = None
    last_rebuild_response: object = None
    while time.monotonic() < poll_deadline:
        try:
            last_rebuild_response = page.evaluate(
                """async (runId) => {
                  const controller = new AbortController();
                  const timeout = setTimeout(() => controller.abort(), 5000);
                  try {
                    const response = await fetch(`/admin/api/runs/${encodeURIComponent(runId)}`, {
                      credentials: 'same-origin',
                      signal: controller.signal,
                    });
                    let body = null;
                    try { body = await response.json(); } catch (_) {}
                    return { ok: response.ok, status: response.status, body };
                  } catch (error) {
                    return { ok: false, status: 0, error: String(error) };
                  } finally {
                    clearTimeout(timeout);
                  }
                }""",
                rebuild_id,
            )
            if (last_rebuild_response and last_rebuild_response.get("ok")):
                candidate = last_rebuild_response.get("body")
                if isinstance(candidate, dict):
                    rebuild = candidate
                    if candidate.get("status") in {"completed", "failed", "cancelled"}:
                        break
        except Exception as exc:
            last_rebuild_response = {"error": repr(exc)}
        page.wait_for_timeout(1000)
    if not rebuild or rebuild.get("status") != "completed":
        raise AssertionError(
            f"Background embedding rebuild did not complete: {rebuild}; "
            f"last response={last_rebuild_response}"
        )
    if "--catch-up" not in (rebuild.get("command") or []):
        raise AssertionError(f"Embedding rebuild was not handed to the catch-up task: {rebuild}")


def mcp_key_search_journey(page: Page) -> None:
    print("[journey 5/6] create MCP Key in Admin -> real HTTP MCP search", flush=True)
    origin = open_admin_from_desktop(page)
    page.goto(origin + "/admin/#mcp")
    page.get_by_role("heading", name="MCP 接入").wait_for()
    page.get_by_role("button", name="+ API Key").click()
    page.get_by_placeholder("例如 claude-code-local").fill("real-e2e-search")
    page.get_by_role("button", name="创建 Key").click()
    page.get_by_text("API Key 已创建").wait_for(timeout=45_000)
    details = page.locator("details.credential-details")
    details.evaluate("element => element.open = true")
    token = details.locator(".code-block span").first.inner_text().strip()
    if len(token) < 24:
        raise AssertionError("Admin did not reveal a usable API Key")
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "search", "arguments": {"query": UNIQUE_MARKER, "limit": 5}},
    }).encode("utf-8")
    request = Request(
        origin + "/mcp",
        data=payload,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
    )
    with urlopen(request, timeout=45) as response:
        result_text = response.read().decode("utf-8")
    if '"result"' not in result_text or UNIQUE_MARKER not in result_text:
        raise AssertionError("The real MCP search did not return the imported document")


def restart_persistence_check(
    playwright: Playwright,
    artifacts: Path,
    home: Path,
    *,
    executable: Path = ELECTRON_EXE,
    application: Path | None = DESKTOP_ROOT,
) -> None:
    print("[journey 6 precheck] restart current Desktop -> imported data persists", flush=True)
    session = DesktopSession(playwright, artifacts, home, executable=executable, application=application)
    page = session.start()
    try:
        origin = open_admin_from_desktop(page)
        page.goto(origin + "/admin/#data")
        page.get_by_role("heading", name="知识数据").wait_for()
        page.get_by_placeholder("搜索 slug 或标题").fill("Real User Journey Orchid")
        page.get_by_role("row", name=re.compile("Real User Journey Orchid")).wait_for(timeout=90_000)
    finally:
        session.stop()


def run(args: argparse.Namespace) -> None:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    artifacts = Path(args.artifacts_dir).resolve() if args.artifacts_dir else DEFAULT_ARTIFACTS_ROOT / stamp
    artifacts.mkdir(parents=True, exist_ok=False)
    home = artifacts / "user-home"
    home.mkdir(parents=True)
    markdown, pdf = write_fixtures(artifacts / "fixtures")
    packaged = bool(args.packaged)
    executable = PACKAGED_EXE if packaged else ELECTRON_EXE
    application = None if packaged else DESKTOP_ROOT
    if not args.skip_build:
        build_current_source(packaged=packaged)
    with LocalOpenAIServer() as provider, sync_playwright() as playwright:
        session = DesktopSession(playwright, artifacts, home, executable=executable, application=application)
        page = session.start()
        try:
            origin, desktop_url = first_launch_journey(page, artifacts, provider)
            import_search_journey(page, origin, markdown, pdf, artifacts)
            delete_restore_journey(page, origin)
            embedding_switch_journey(page, artifacts, provider, desktop_url)
            mcp_key_search_journey(page)
        except Exception:
            try:
                page.screenshot(path=str(artifacts / "failure.png"), full_page=True)
                (artifacts / "failure-page.txt").write_text(
                    f"url={page.url}\ntitle={page.title()}\n\n{page.locator('body').inner_text()}\n",
                    encoding="utf-8",
                )
            except Exception:
                pass
            raise
        finally:
            session.stop()
        restart_persistence_check(
            playwright,
            artifacts,
            home,
            executable=executable,
            application=application,
        )
    print(f"[passed] real PMBrain core user journeys; artifacts: {artifacts}")
    print("[note] the cross-version NSIS upgrade journey is run separately by test:user-journeys:upgrade")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run real PMBrain Desktop/Admin core user journeys")
    parser.add_argument("--skip-build", action="store_true", help="Reuse the current Admin/Desktop build output")
    parser.add_argument(
        "--packaged",
        action="store_true",
        help="Launch desktop/dist/win-unpacked/PMBrain.exe after building the unpacked Windows app",
    )
    parser.add_argument("--artifacts-dir", help="Directory for isolated PMBRAIN_HOME, fixtures, logs and screenshots")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        run(parse_args())
    except KeyboardInterrupt:
        raise
    except Exception as error:
        print(f"[failed] {error}", file=sys.stderr)
        raise
