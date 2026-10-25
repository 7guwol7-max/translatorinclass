# 사용설명서 만들기

교사용 사용설명서 PDF(`docs/manual/ClassroomInterpreter-Manual-ko.pdf`)를 만드는 도구입니다.
Release 를 만들 때 GitHub Actions 가 이 PDF 를 설치 파일과 함께 붙입니다.

```
docs/manual/manual.html   설명서 본문 (A4 인쇄용 HTML)
docs/manual/img/          화면 그림 (capture.mjs 가 만듦) + QR 코드
tools/manual/capture.mjs  빌드한 실제 화면을 Chromium 으로 띄워 찍기 (예시 데이터, 가짜 마이크, 빨간 번호 표시)
tools/manual/stage/       자막 창을 띄워 찍을 수업 슬라이드
tools/manual/build-pdf.mjs  manual.html → PDF (쪽 번호)
```

## 다시 만들기
화면이 바뀌었으면 그림부터 다시 찍고, 본문만 고쳤으면 PDF 만 다시 만듭니다.
```bash
cd apps/desktop && npm ci && npm run build && cd ../..
node tools/manual/capture.mjs     # 그림 (docs/manual/img/*.png)
node tools/manual/build-pdf.mjs   # PDF
```
필요한 것: Playwright 와 Chromium, 한글 글꼴 **Pretendard** (Windows 의 맑은 고딕 대신 씀, SIL OFL).
크메르어·미얀마어 이름까지 제대로 보이려면 Noto Sans Khmer·Myanmar 도 설치합니다.

- 그림에 나오는 키·자막·사용량은 모두 예시 데이터입니다 (`capture.mjs` 의 `BASE`, `CAPTIONS`).
- 버전을 올리면 `manual.html` 표지와 `build-pdf.mjs` 쪽 아래 글의 버전도 바꿉니다.
