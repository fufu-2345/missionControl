#!/usr/bin/env bash
# install.sh — ดึง skill ในโฟลเดอร์นี้ไปวางที่ ~/.claude/skills/ (live location ที่ Claude Code โหลด)
# ใช้ตอน clone missionControl/soulbrew ไปเครื่องใหม่ แล้วอยากใช้ /orches
#
#   bash claude-skills/install.sh
#
# เสร็จแล้ว reload / restart Claude Code → /orches จะขึ้นใน autocomplete
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude/skills"

# รายชื่อ skill ที่จะ install (ชื่อ = ชื่อโฟลเดอร์ใน claude-skills/)
SKILLS=(orches)

mkdir -p "$DEST"
for skill in "${SKILLS[@]}"; do
  if [ ! -f "$SRC/$skill/SKILL.md" ]; then
    echo "✗ ข้าม $skill — ไม่เจอ $SRC/$skill/SKILL.md"
    continue
  fi
  mkdir -p "$DEST/$skill"
  # สำรองของเดิมถ้ามี (กันทับงานที่ยังไม่ได้ commit)
  if [ -f "$DEST/$skill/SKILL.md" ] && ! cmp -s "$SRC/$skill/SKILL.md" "$DEST/$skill/SKILL.md"; then
    cp "$DEST/$skill/SKILL.md" "$DEST/$skill/SKILL.md.bak.$(date +%s 2>/dev/null || echo prev)"
    echo "  (ของเดิมต่างกัน — สำรองเป็น SKILL.md.bak.* ก่อนทับ)"
  fi
  cp "$SRC/$skill/SKILL.md" "$DEST/$skill/SKILL.md"
  echo "✓ installed /$skill → $DEST/$skill/SKILL.md"
done

echo
echo "เสร็จ — reload / restart Claude Code แล้วพิมพ์ /orches ได้เลย"
