#!/usr/bin/env bash

# GitHub Copilot設定の取り込みスクリプト
#
# 公開リポジトリの .github/ 配下を、このプロジェクトの .github/ へ取り込む。
# 取得元の既定は https://github.com/wate/lde とする(--repo で変更できる)。
#
# 使い方:
#   scripts/import-copilot-settings.sh              # 既定ブランチの .github を取り込む
#   scripts/import-copilot-settings.sh --ref <ref>  # ブランチ・タグ・コミットを指定
#   scripts/import-copilot-settings.sh --delete     # 取り込み先の余分なファイルを削除(ミラー化)
#   scripts/import-copilot-settings.sh --dry-run    # 変更せず、実行内容のみ表示
#   scripts/import-copilot-settings.sh --help       # ヘルプ表示

set -euo pipefail

# ---- 既定値 ----

REPO_URL="https://github.com/wate/lde"
REF=""
SUBDIR=".github"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${PROJECT_ROOT}/${SUBDIR}"

DELETE=false
DRY_RUN=false

# ---- ログ出力 ----

COLOR_RED="\033[31m"
COLOR_YELLOW="\033[33m"
COLOR_GREEN="\033[32m"
COLOR_RESET="\033[0m"

log_info() { printf "%s\n" "$1"; }

log_warn() { printf "  %bWARN:%b %s\n" "$COLOR_YELLOW" "$COLOR_RESET" "$1"; }

log_error() { printf "%bERROR:%b %s\n" "$COLOR_RED" "$COLOR_RESET" "$1" >&2; }

log_done() { printf "%bDONE:%b %s\n" "$COLOR_GREEN" "$COLOR_RESET" "$1"; }

usage() {
    cat <<EOF
使い方: $(basename "$0") [options]

公開リポジトリの ${SUBDIR}/ を、このプロジェクトの ${SUBDIR}/ へ取り込みます。

オプション:
    --repo <url>   取り込み元リポジトリ (既定: ${REPO_URL})
    --ref <ref>    ブランチ・タグ・コミット (既定: リポジトリの既定ブランチ)
    --dest <dir>   取り込み先ディレクトリ (既定: ${PROJECT_ROOT}/${SUBDIR})
    --delete       取り込み先の余分なファイルを削除してミラー化する
    --dry-run      変更を加えず、実行内容のみ表示する
    -h, --help     このヘルプを表示
EOF
}

# ---- 引数の解析 ----

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo)
            [[ $# -ge 2 ]] || { log_error "--repo には値が必要です"; exit 2; }
            REPO_URL="$2"
            shift 2
            ;;
        --ref)
            [[ $# -ge 2 ]] || { log_error "--ref には値が必要です"; exit 2; }
            REF="$2"
            shift 2
            ;;
        --dest)
            [[ $# -ge 2 ]] || { log_error "--dest には値が必要です"; exit 2; }
            TARGET_DIR="$2"
            shift 2
            ;;
        --delete)
            DELETE=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log_error "不明なオプション: $1"
            usage >&2
            exit 2
            ;;
    esac
done

# ---- 前提コマンドの確認 ----

if ! command -v git >/dev/null 2>&1; then
    log_error "git が見つかりません"
    exit 1
fi

HAS_RSYNC=false
if command -v rsync >/dev/null 2>&1; then
    HAS_RSYNC=true
fi

if [[ "$DELETE" == true && "$HAS_RSYNC" != true ]]; then
    log_error "--delete には rsync が必要です"
    exit 1
fi

# ---- 一時ディレクトリ ----

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# .github のみを取得する。sparse checkout に失敗した場合は通常の clone へ切り替える。
clone_repo() {
    local dest="$1"
    local args=(--depth 1 --filter=blob:none --sparse)
    if [[ -n "$REF" ]]; then
        args+=(--branch "$REF")
    fi

    if git clone "${args[@]}" "$REPO_URL" "$dest" 2>/dev/null; then
        if git -C "$dest" sparse-checkout set "$SUBDIR" >/dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

log_info "取得元: ${REPO_URL} (ref: ${REF:-既定ブランチ})"

if ! clone_repo "${TMP_DIR}/repo"; then
    log_warn "sparse checkout での取得に失敗したため、通常の clone に切り替えます"
    rm -rf "${TMP_DIR}/repo"
    if [[ -n "$REF" ]]; then
        git clone --depth 1 --branch "$REF" "$REPO_URL" "${TMP_DIR}/repo"
    else
        git clone --depth 1 "$REPO_URL" "${TMP_DIR}/repo"
    fi
fi

SRC_DIR="${TMP_DIR}/repo/${SUBDIR}"
if [[ ! -d "$SRC_DIR" ]]; then
    log_error "取得元に ${SUBDIR}/ が見つかりません: ${REPO_URL}"
    exit 1
fi

# ---- 取り込み ----

log_info "取得先: ${TARGET_DIR}"

RSYNC_OPTS=(-a)
if [[ "$DELETE" == true ]]; then
    RSYNC_OPTS+=(--delete)
fi
if [[ "$DRY_RUN" == true ]]; then
    RSYNC_OPTS+=(--dry-run --itemize-changes)
fi

if [[ "$HAS_RSYNC" == true ]]; then
    if [[ "$DRY_RUN" != true ]]; then
        mkdir -p "$TARGET_DIR"
    fi
    rsync "${RSYNC_OPTS[@]}" "${SRC_DIR}/" "${TARGET_DIR}/"
else
    # rsync が無い場合はコピーのみ(--delete は上で拒否済み)
    if [[ "$DRY_RUN" == true ]]; then
        log_info "(dry-run) cp -R ${SRC_DIR}/. ${TARGET_DIR}/"
    else
        mkdir -p "$TARGET_DIR"
        cp -R "${SRC_DIR}/." "${TARGET_DIR}/"
    fi
fi

if [[ "$DRY_RUN" == true ]]; then
    log_done "dry-run のため変更は行っていません"
else
    log_done "${SUBDIR}/ を取り込みました: ${TARGET_DIR}"
fi
