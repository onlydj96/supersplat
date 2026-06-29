# SuperSplat Custom Viewer — 호환성 가이드

> spacehong.com 연동 기준 작성. `API_INTERFACE.md`(공식 PlayCanvas 호스팅 뷰어 명세)와의 차이점 정리.

---

## URL 파라미터 대응표

| API_INTERFACE.md 파라미터 | 우리 뷰어 지원 여부 | 비고 |
|---------------------------|---------------------|------|
| `?content=<url>` | ✅ 지원 | `?load=`의 별칭으로 동작 |
| `?poster=<url>` | ✅ 지원 | 로딩 중 미리보기 이미지 표시, 로딩 완료 시 fade-out |
| `?aa` | ✅ 지원 | 플래그 존재 시 안티앨리어싱 활성화 |
| `?settings=<url>` | ❌ 미지원 | → [config.json 대체 방식](#configjson-대체-방식) 참고 |
| `?skybox=<url>` | ❌ 미지원 | 배경 스카이박스 렌더링 미구현 |
| `?noui` | 해당 없음 | 우리 뷰어는 내장 UI가 없으므로 이 플래그 자체가 불필요 |
| `?noanim` | 해당 없음 | 애니메이션 트랙 시스템이 뷰어에 포함되지 않음 |
| `?nofx` | 해당 없음 | 후처리 효과가 뷰어에 포함되지 않음 (에디터 전용) |
| `?webgl` | 해당 없음 | 뷰어는 WebGL2 전용으로 이미 고정 |

---

## 공식 뷰어와 다른 추가 파라미터

우리 뷰어에만 있는 파라미터 (공식 뷰어에는 없음):

| 파라미터 | 설명 |
|----------|------|
| `?load=<url>` | 스플랫 파일 로딩 (반복 사용 가능 — 여러 파일 동시 로딩) |
| `?filename=<name>` | n번째 `?load=` 파일의 표시 이름 지정 |
| `?autorotate=<deg/s>` | 자동 회전 속도 (deg/s). `?autorotate=20` |
| `?mode=walk` | 1인칭 걷기 모드로 시작 (WASD + 마우스 시점) |
| `?config.<key>=<val>` | 씬 설정 직접 오버라이드 (예: `?config.bgClr.r=0.1`) |
| `?focal=x,y,z` | 카메라 초점 위치 지정 |
| `?angles=azim,elev` | 카메라 초기 방위각/고도 |
| `?distance=<d>` | 카메라 초기 거리 |

---

## config.json 대체 방식

공식 뷰어의 `?settings=<url>` + `settings.json`은 지원하지 않습니다.
대신 서버에 배포된 `config.json`으로 동일한 효과를 얻습니다.

**공식 settings.json (지원 안 함)**:
```json
{
  "version": 2,
  "tonemapping": "aces2",
  "postEffectSettings": { "bloom": { "enabled": true } },
  "cameras": [{ "position": [0, 1.5, 4], "target": [0, 1, 0], "fov": 60 }]
}
```

**우리 config.json (대체 방식)**:
```json
{
  "activeProject": "spacehong-hall",
  "projects": {
    "spacehong-hall": {
      "name": "스페이스홍 공연장",
      "file": "data/spacehong-hall/model.compressed.ply",
      "viewer": {
        "background": "#1a1a2e",
        "mode": "orbit",
        "autorotate": 0,
        "fov": 60
      }
    }
  }
}
```

> 카메라 초기 위치는 URL 파라미터로 설정합니다:
> `?focal=0,1,0&angles=0,20&distance=4`

---

## spacehong TourPage.jsx 적용 가이드

### 최소 구성 (Method A 공식 뷰어 방식 → 우리 뷰어로 변환)

**기존 코드 (공식 PlayCanvas 호스팅)**:
```jsx
const viewerSrc = `https://supersplat.playcanvas.com/viewer
  ?content=${encodeURIComponent(SPLAT_FILE_URL)}
  &poster=${encodeURIComponent(POSTER_URL)}
  &noui`;
```

**변환 후 (우리 커스텀 뷰어)**:
```jsx
// VITE_VIEWER_BASE: 우리 뷰어가 배포된 URL (예: https://viewer.spacehong.com/viewer.html)
const VIEWER_BASE = import.meta.env.VITE_VIEWER_BASE;
const SPLAT_URL   = import.meta.env.VITE_SPLAT_URL;
const POSTER_URL  = import.meta.env.VITE_TOUR_POSTER_URL;

const viewerSrc = `${VIEWER_BASE}` +
  `?content=${encodeURIComponent(SPLAT_URL)}` +
  `&poster=${encodeURIComponent(POSTER_URL)}`;
  // &aa  ← 안티앨리어싱 원하면 추가
  // &mode=walk  ← 1인칭 걷기 모드 원하면 추가
```

> `?noui`는 제거해도 됩니다. 우리 뷰어는 UI가 없으므로 효과 없음.

---

## postMessage API (공식 뷰어에 없는 기능)

우리 뷰어는 부모 페이지와 양방향 통신이 가능합니다.

### 부모 → iframe (제어 명령)

```js
const iframe = document.querySelector('iframe');

// 파일 로드
iframe.contentWindow.postMessage({
    type: 'supersplat-viewer:load',
    url: 'https://cdn.example.com/hall.ply'
}, '*');

// 배경색 변경
iframe.contentWindow.postMessage({
    type: 'supersplat-viewer:set-background',
    color: '#1a1a2e'   // '#rrggbb' | '#rrggbbaa' | 'transparent'
}, '*');

// 자동 회전 켜기
iframe.contentWindow.postMessage({
    type: 'supersplat-viewer:set-autorotate',
    enabled: true,
    speed: 15   // deg/s
}, '*');

// 1인칭 걷기 모드 전환
iframe.contentWindow.postMessage({
    type: 'supersplat-viewer:set-control-mode',
    mode: 'walk'   // 'orbit' | 'walk'
}, '*');

// 카메라 리셋
iframe.contentWindow.postMessage({ type: 'supersplat-viewer:reset-camera' }, '*');
```

### iframe → 부모 (이벤트 수신)

```js
window.addEventListener('message', (event) => {
    switch (event.data.type) {
        case 'supersplat-viewer:ready':
            console.log('뷰어 초기화 완료');
            break;
        case 'supersplat-viewer:loaded':
            console.log('파일 로드됨:', event.data.url, event.data.splatCount, '스플랫');
            break;
        case 'supersplat-viewer:error':
            console.error('로드 오류:', event.data.message);
            break;
    }
});
```

---

## 미지원 기능 상세

### `?settings=` / settings.json

공식 뷰어의 `settings.json`은 tonemapping, bloom/grading 등 후처리 효과와
카메라 애니메이션 트랙을 제어합니다. 우리 뷰어는 렌더링 파이프라인을
에디터에서 직접 빌드하므로 이 포맷과 구조가 다릅니다.

- **tonemapping**: 에디터의 씬 설정으로 제어 (URL에서는 `?config.*` 파라미터)
- **postEffectSettings (bloom, grading 등)**: 에디터 전용 기능. 뷰어 빌드에 미포함
- **cameras[].position/target**: URL 파라미터 `?focal=`, `?angles=`, `?distance=`로 대체

### `?skybox=`

PlayCanvas 엔진의 스카이박스 텍스처 로딩 코드가 현재 뷰어에 통합되어 있지 않습니다.
배경은 단색(hex)으로만 지정 가능합니다 (`?config.bgClr.r/g/b` 또는 postMessage).

### `?noanim`

SuperSplat 에디터에서 export한 animTracks 데이터를 재생하는 기능이 뷰어 빌드에 포함되지 않습니다. 정적 스플랫 파일 렌더링만 지원합니다.

---

*마지막 업데이트: 우리 커스텀 뷰어 v2.28.0 기준*
