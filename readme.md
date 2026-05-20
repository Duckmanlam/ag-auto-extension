## Ổn định hơn, tin cậy hơn

> Phiên bản v9.6.4 cải thiện độ ổn định khi bật/tắt Auto Click & Scroll, giúp extension hoạt động mượt và đáng tin cậy hơn.

---

## ☕ Ủng hộ tác giả

Nếu extension giúp ích cho bạn, mời tác giả một ly cà phê nhé! ☕  

<p align="center">
</p>

> 🙏 Mọi sự ủng hộ đều là động lực để mình tiếp tục phát triển extension miễn phí cho cộng đồng!

---

# AG Auto Click & Scroll v9.6.4

**Extension tự động nhấn nút Run, Allow, Allow in workspace, Accept, Accept all và cuộn khung chat Antigravity.**  
Thiết kế thông minh — Accept chỉ click ở **khung chat**, tuyệt đối không click ở editor.  
Hỗ trợ **giới hạn click** cho từng nút — click đúng số lần rồi dừng.

> Hỗ trợ **Windows & Linux** — tự động xử lý quyền ghi file trên mọi hệ điều hành.

---

## Có gì mới trong v9.6.4

### ✅ Ổn định hơn khi sử dụng
- **Fix lỗi ON nhưng không click** — tự reset HTTP IPC server nếu server object tồn tại nhưng chưa listen port, tránh `Port scan: no server found`.
- **Fix nút Allow permission JavaScript** — nhận diện card `Agent needs permission to execute JavaScript...` khi chạy landing page và click đúng nút Allow.
- **Fix click nhầm Run and Debug** — chặn Activity Bar / navigation controls để không nhầm với nút Run trong chat.
- **Fix tìm nút Run tốt hơn** — đọc thêm `aria-label`/`title` khi nút không có text rõ ràng.

## Có gì mới trong v9.5.1

### 🔴 Fix lỗi trạng thái ON giả khi runtime đã chết
- **Fix status bar báo ON sai sự thật** — Trước đây có case injected script đã tự disable do `server lost` hoặc `bindRejected`, nhưng Extension Host vẫn giữ state cũ nên status bar vẫn hiện **Accept ON / Scroll ON**. Giờ script sẽ chủ động báo tình trạng runtime về host, và status bar sẽ chuyển sang **DEGRADED** để phản ánh đúng thực tế.
- **Thêm runtime health sync** — Extension giờ có kênh đồng bộ riêng để biết khi nào script đang healthy, khi nào đang fail tạm thời do mất bind, mismatch owner, hoặc mất kết nối poll.
- **Cải thiện khả năng chẩn đoán lỗi** — Tooltip status bar giờ giải thích rõ khi auto đang ở trạng thái degraded và gợi ý Reload Window / mở lại Antigravity nếu runtime không tự recover.

### 🔧 Auto-recovery — Script tự hồi phục khi mất kết nối
- **Tự retry sau bind rejection** — Trước đây script bị reject là chết luôn. Giờ sẽ tự retry discovery với delay tăng dần (5s → 10s → 30s) cho đến khi server accept.
- **Stale owner detection** — Server tự release ownerKey nếu owner cũ không poll >30s, cho phép script mới claim lại mà không cần Reload Window.
- **Backup re-discover** — Khi mất server, ngoài retry ngay lập tức còn có retry backup sau 8s để tăng khả năng reconnect khi AG đang restart.

## Có gì mới trong v9.5

### 🔴 Fix lỗi nghiêm trọng — Auto-click tự tắt sau một thời gian
- **Fix JSON.parse crash trong HTTP poll** — Nguyên nhân chính khiến auto-click tự tắt sau khi chạy một lúc. Khi server trả response bị cắt (do CPU cao, server restart, hoặc network lag), `JSON.parse` throw exception nhưng không có `try-catch` → poll errors tích lũy → auto-click tự disable sau ~18 giây. Giờ lỗi parse được xử lý mượt, stats tự rollback, và kết nối không bị gián đoạn.
- **Fix tốc độ quét click bị kẹt ở 5 giây** — Dù set 10s, 30s hay 50s trong Settings, click loop luôn chạy tối đa 5000ms do clamp xung đột giữa `_agApplyConfig` (cho phép 120s) và `_agStartClickLoop` (giới hạn 5s). Giờ cả hai dùng chung max 120000ms — set bao nhiêu chạy đúng bấy nhiêu.
- **Fix UI input max** — Ô nhập "Tốc độ quét click" trên dashboard trước đây giới hạn max=5000, giờ cho phép đến 120000ms.

### 🎨 Cải thiện Dashboard
- **Thêm hint cho ô tốc độ click** — Giải thích rõ: giá trị cao hơn = chờ lâu hơn giữa mỗi lần click, giúp review code trước khi auto-click tiếp.
- **Fix i18n Auto Scroll** — Subtitle "Smart follow with manual pause" giờ hiển thị đúng ngôn ngữ (VN/EN/ZH) thay vì luôn tiếng Anh.
- **Fix duplicate content** — Hint dưới ô click không còn bị trùng với subtitle phía trên.

---

## Có gì mới trong v9.4

### 🐛 Sửa lỗi ổn định — "Dùng một lúc là bị"
- **Fix WeakSet kẹt nút** — Nguyên nhân chính khiến extension ngừng click sau khi dùng một thời gian. Nút đã click giờ tự giải phóng sau 30s, cho phép click lại khi DOM được tái sử dụng.
- **Tăng ngưỡng mất kết nối** — Từ 4 lên 9 lần poll error liên tiếp trước khi tắt auto-click. Giảm false-positive khi CPU cao hoặc server bận.
- **Giữ port kết nối** — Không reset port về 0 khi re-scan provisional, giữ kết nối ổn định hơn.
- **Tự re-discover server** — Khi mất kết nối, tự động tìm lại server ngay thay vì chờ.
- **Không mất click stats** — Stats không bị mất khi XHR timeout, tự rollback về session pending.

### 🎛️ Sửa lỗi tốc độ quét click
- **Click interval áp dụng ngay** — Trước đây đổi "Tốc độ quét click (ms)" rồi Save & Apply nhưng vẫn chạy tốc độ cũ. Giờ setInterval được restart lại khi giá trị thay đổi.
- **Commands API loop cũng restart** — Loop VS Code Commands API giờ cũng cập nhật tốc độ khi Save & Apply.

### 📊 Click Stats Dashboard
- **Chỉ giữ 10 nút chính** — Bỏ Continue, chỉ hiển thị 10 pattern quan trọng nhất.
- **Mặc định Most clicked** — Sắp xếp theo số click giảm dần, có dropdown để đổi.
- **Layout 2 cột dọc** — Thứ tự: cột trái 1-5, cột phải 6-10.
- **Một hệ màu cyan** — Tất cả bar dùng cùng gradient, không loạn màu.
- **Sửa nhận diện Allow in Workspace** — Thống kê/log đúng pattern thay vì bị gom vào Allow.
- **Click Log compact** — Search + Pattern filter trên cùng 1 hàng để xem nhiều log hơn.

---

## Cập nhật nhanh v9.3

> Bản v9.3 thêm **Health Indicator** trên dashboard và fix bug scroll preference không được lưu.

### Các thay đổi chính
- **Health Indicator** — Hiển thị Server port và trạng thái Script inject ngay trên dashboard header. Giúp user biết mình đang kết nối ở port nào (hữu ích khi mở nhiều cửa sổ Antigravity).
- **Fix scrollEnabled không persist** — Khi tắt Auto Scroll rồi reload window, giờ scroll sẽ giữ đúng trạng thái thay vì luôn bật lại ON.
- Hỗ trợ i18n (Việt/Anh/Trung) cho Health Indicator.
- Đa ngôn ngữ cải thiện: thêm các chuỗi dịch cho Server/Script/Port/Injected.

---

## Có gì mới trong v9.0

### 🎯 Giới hạn Click (Click Limits)
- Đặt **Max clicks** cho từng nút — VD: Run chỉ click **5 lần** rồi dừng
- Trống hoặc `0` = **Vô Hạn** (click mãi mãi, mặc định)
- Nút **"Vô Hạn"** để xóa nhanh giới hạn trên giao diện
- Giới hạn theo **session** — reset khi Reload Window
- Áp dụng cho **tất cả** pattern: Run, Allow, Accept, Always Allow, Keep Waiting...
- Chỉ cần nhập số + nhấn **Save & Apply** → có hiệu lực ngay

### 🛡️ Tự tắt khi Disable/Uninstall (Safe Disable)
- Script mặc định **OFF** — chỉ bật khi extension server xác nhận
- Disable hoặc uninstall extension → server tắt → script **tự ngừng click** sau ~6 giây
- Cài lại extension → script tự reconnect và bật lại
- Không còn tình trạng "zombie click" khi đã tắt extension

### Dashboard ổn định hơn
- Fix lỗi dashboard trắng khi webview bị lỗi render
- Phần stats, log và controls không còn bị một panel phụ làm crash toàn bộ UI
- Tối ưu lại luồng khởi tạo để mở settings ổn định hơn
- Bổ sung hỗ trợ nút **Allow in workspace** để auto-click khớp hơn với luồng quyền mới

### Multi-Instance
- Hỗ trợ chạy **2+ cửa sổ Antigravity** cùng lúc — không còn xung đột port
- Dynamic port: tự tìm port trống trong range 48787-48850
- Auto-discovery: script tự dò port server, tự reconnect khi mất kết nối
- Fix triệt để lỗi RAM nhảy 20GB khi mở nhiều instance

### Log Click Stats
- Ghi log chi tiết mỗi lần auto-click vào bảng thống kê
- Hiển thị lịch sử click realtime trong Settings panel

### Hỗ trợ nút Accept
- Tự động click **Accept** ở khung chat — tuyệt đối không click ở diff editor
- Phân biệt Accept (chat) vs Accept Changes/Accept All (editor) bằng DOM context
- Commands API chỉ chạy `acceptAgentStep` (chat), không chạy `agentAcceptAllInFile` (editor)
- Accept mặc định **ON**, hoạt động ngay khi cài — không cần Save & Apply

### Fix thông báo "Corrupt Installation"
- Tự động cập nhật checksums sau khi inject → xóa hoàn toàn cảnh báo "corrupt"
- Tự reload sau update checksums + tự đóng notification nếu vẫn hiện
- Tự phát hiện extension upgrade → re-inject script mới tự động

### Click Stats Dashboard
- Bảng thống kê click realtime ngay trong Settings với progress bar so sánh
- Nút click nhiều nhất tự động nhận vương miện
- Lưu thống kê qua restart, chỉ mất khi ấn Reset

### Native Dialog Auto-Click (Win32)
- Tự động nhấn **Keep Waiting** trong dialog "window not responding" bằng Win32 API

### Giao diện đơn giản hơn
- Bỏ ô nhập nút tùy chỉnh — chỉ giữ các nút mặc định, toggle ON/OFF
- Clean injection — chỉ dùng HTML script tag, ổn định hơn
- Bổ sung vài tinh chỉnh nhỏ cho dashboard để nhìn gọn và dễ thao tác hơn

---

## Tính năng chính

| Tính năng | Mô tả |
|-----------|-------|
| **Auto Click** | Tự động nhấn Run, Allow, Allow in workspace, Always Allow, Accept, Accept all, Keep Waiting... |
| **Click Limits** | Giới hạn số click cho từng nút — VD: Run click 5 lần rồi dừng. Trống = Vô Hạn |
| **Auto Scroll** | Cuộn khung chat xuống cuối để không bỏ lỡ nội dung mới |
| **Click Stats** | Bảng thống kê click realtime với progress bar và badge |
| **Instant Toggle** | Gạt switch ON/OFF → áp dụng tức thì, không cần Save hay Reload |
| **Tắt/Bật riêng** | Accept và Scroll có toggle riêng, hoạt động độc lập |
| **HTTP Live Sync** | Settings cập nhật realtime qua HTTP server nội bộ |
| **Smart Accept** | Accept chỉ click ở **khung chat** — không click ở diff editor |
| **Diff Protection** | KHÔNG click Accept Changes/Accept All/Accept Incoming trong editor |
| **Settings UI** | Giao diện đẹp — bật/tắt từng nút, chỉnh tốc độ, đa ngôn ngữ |
| **Dual Status Bar** | Hiện Accept ON/OFF và Scroll ON/OFF riêng biệt, màu xanh/đỏ |


---

## Danh sách nút hỗ trợ

Mặc định **ON**: `Run` · `Allow` · `Allow in workspace` · `Accept` · `Always Allow` · `Keep Waiting` · `Retry` · `Continue` · `Allow Once` · `Allow This Con`

Mặc định **OFF**: `Accept all` (bật thủ công khi cần)

> `Accept` chỉ click ở khung chat, không click ở editor. Bạn có thể thêm nút tùy chỉnh hoặc bật/tắt từng nút trong Settings.

---

## Cách sử dụng / Hướng dẫn chạy code

### Cách 1: Cài đặt trực tiếp từ source code (Khuyên dùng cho Antigravity IDE)
Nếu bạn có source code, cách nhanh nhất là copy thẳng vào thư mục cài đặt extension của Antigravity IDE:
1. Mở Terminal.
2. Xóa bản cũ (nếu có):
   ```bash
   rm -rf ~/.antigravity-ide/extensions/duckmanlam.duckmanlam-auto-vip*
   rm -rf ~/.antigravity/extensions/duckmanlam.duckmanlam-auto-vip*
   ```
3. Copy source code vào đúng thư mục:
   ```bash
   cp -r /đường/dẫn/đến/thư/mục/source ~/.antigravity-ide/extensions/duckmanlam.duckmanlam-auto-vip-1.0.0
   cp -r /đường/dẫn/đến/thư/mục/source ~/.antigravity/extensions/duckmanlam.duckmanlam-auto-vip-1.0.0
   ```
4. Mở Antigravity IDE, nhấn `Cmd + Shift + P` (Mac) hoặc `Ctrl + Shift + P` (Win) -> Gõ **`Reload Window`** và ấn Enter.

### Cách 2: Cài đặt từ file `.vsix`
1. Build file `.vsix` (nếu chưa có): Mở Terminal tại thư mục source code, chạy lệnh `npx -y @vscode/vsce package`.
2. Mở Antigravity / VS Code.
3. Nhấn `Cmd+Shift+P` (hoặc `Ctrl+Shift+P`) → Chọn `Extensions: Install from VSIX...`
4. Chọn file `.vsix` vừa build → Cài đặt → **Reload Window**.
5. Extension sẽ tự động inject script và **auto-reload** ở lần đầu tiên.

> **Lưu ý trên Mac/Linux**: Quá trình inject script lần đầu có thể yêu cầu nhập mật khẩu máy tính để cấp quyền ghi file vào hệ thống.

### Hướng dẫn mở Settings (Bảng điều khiển)
Bạn có thể mở giao diện cài đặt bằng **1 trong 3 cách**:
- **Cách 1**: Click chuột vào chữ **`✓ Accept ON`** hoặc **`✓ Scroll ON`** trên Status Bar (góc dưới cùng bên phải IDE).
- **Cách 2**: Nhấn `Cmd + Shift + P` → Gõ `AG Auto: Open Settings`.
- **Cách 3**: Nhấn `Cmd + J` để mở Panel bên dưới (cùng chỗ với Terminal/Output) → Chọn tab **AG Auto Settings** (có icon 🦆).

### Gỡ bỏ
Nhấn `Cmd + Shift + P` → Gõ `AG Auto: Disable (Remove Script)` → Chờ thông báo thành công và **Reload Window**.

---

> **Safe Click**: Script chỉ click nút nằm trong approval dialog (có nút Reject/Deny/Cancel bên cạnh). Không click nhầm diff editor, navigation, sidebar, hay dialog khác.

---

## Click Stats


## Giao diện Settings


---

## Changelog

### Bản VIP Mới Nhất (Fix Lỗi Panel & Command)
- **Fix triệt để lỗi `command 'ag-auto.openSettings' not found`**: Đảm bảo các lệnh luôn được đăng ký trước tiên khi extension khởi động.
- **Fix lỗi hiển thị Settings Panel**: Cấu hình lại chuẩn xác `viewsContainers` và `views` trong `package.json` và đăng ký `WebviewViewProvider` để panel "AG Auto Settings" xuất hiện mượt mà trong thanh Bottom Panel của IDE.
- **Tự động click Accept mượt mà**: Hoàn thiện logic tự động click nút Submit trên các hộp thoại xin quyền.

### v9.6.4 (Core Base)
- **Fix lỗi ON nhưng không click**: tự reset HTTP IPC server nếu server object tồn tại nhưng chưa listen port, tránh `Port scan: no server found`.
- **Fix nút Allow permission JavaScript**: nhận diện card `Agent needs permission to execute JavaScript...` khi chạy landing page và click đúng nút Allow.
- **Fix click nhầm Run and Debug**: chặn Activity Bar / navigation controls để không nhầm với nút Run trong chat.
- **Fix tìm nút Run tốt hơn**: đọc thêm `aria-label`/`title` khi nút không có text rõ ràng.

### v9.5.2

- **Light Mode**: Settings panel giờ hỗ trợ đầy đủ VS Code light theme — tự detect `.vscode-light` class và áp dụng bảng màu sáng (background, text, cards, inputs, buttons, progress bars, badges).

### v9.5.1
- **Bugfix quan trọng**: Fix trạng thái **Accept ON / Scroll ON giả** khi injected runtime đã tự disable do `server lost` hoặc `bindRejected`.
- **Runtime Health Sync**: Script giờ báo trạng thái degraded/healthy ngược về Extension Host để status bar phản ánh đúng thực tế.
- **Status Bar**: Thêm trạng thái **DEGRADED** và tooltip giải thích khi runtime đang lỗi tạm thời.
- **Auto-Recovery**: Script tự retry discovery sau bind rejection (progressive delay 5s→30s) thay vì chết luôn.
- **Stale Owner Detection**: Server tự release ownerKey nếu owner không poll >30s — cho phép script mới claim lại sau AG restart.
- **Backup Re-discover**: Thêm retry thứ 2 sau 8s khi server lost — tăng khả năng reconnect khi AG đang restart.

### v9.5.0
- **Bugfix nghiêm trọng**: JSON.parse crash trong HTTP poll khiến auto-click tự tắt sau một thời gian — giờ có try-catch + stats rollback.
- **Bugfix nghiêm trọng**: Tốc độ quét click bị kẹt ở 5000ms do clamp xung đột — giờ tôn trọng đúng giá trị user set (200ms–120s).
- **Bugfix**: UI input max click interval từ 5000 lên 120000ms.
- **UI**: Thêm hint giải thích cho ô tốc độ quét click.
- **UI**: Fix subtitle Auto Scroll luôn hiện tiếng Anh — giờ hiển thị đúng ngôn ngữ.
- **UI**: Fix duplicate hint content trong panel Auto Click.

### v9.4.0
- **Bugfix quan trọng**: Sửa lỗi "dùng một lúc là bị" — nút bị kẹt trong WeakSet, giờ tự giải phóng sau 30s.
- **Bugfix**: Tốc độ quét click không áp dụng sau Save & Apply — setInterval giờ restart khi giá trị thay đổi.
- **Bugfix**: Commands API loop cũng restart theo tốc độ mới.
- Tăng ngưỡng poll error lên 9 lần, tự re-discover server khi mất kết nối.
- Giữ port kết nối khi re-scan provisional, không mất stats khi XHR timeout.
- Click Stats: 10 nút chính, Most clicked mặc định, rank 1-10, layout 2 cột dọc, gradient cyan thống nhất.
- Click Log: compact toolbar, bỏ Continue, sửa nhận diện Allow in Workspace.
- Responsive layout: tự co giãn theo chiều rộng webview.

### v9.3.0
- **Health Indicator** — Hiển thị Server port và Script inject status trên dashboard
- **Fix scrollEnabled** không persist sau reload — lưu vào globalState
- Cải thiện i18n cho health indicator (Việt/Anh/Trung)

### v9.2.0
- Fix mặc định **Accept OFF** sau khi restart (restore từ `startupEnabledPreference`)
- Đồng bộ trạng thái giữa **Dashboard ↔ Status Bar ↔ Runtime**
- Fix điểm ghi đè state trong `startCommandsLoop()`
- Thêm cơ chế bind chặt renderer/server bằng `windowKey + startedAt` để tránh loạn trạng thái multi-window

### v9.0.0
- **Click Limits** — Giới hạn số click cho từng nút, trống = Vô Hạn
- **Nút "Vô Hạn"** — Xóa nhanh giới hạn trên giao diện
- **Safe Disable** — Script tự tắt khi disable/uninstall extension, không còn zombie click
- **Promotion System** — Thông báo tài khoản giá rẻ thông minh, tự retry

### v8.3.0
- **Smart Auto Scroll** — Tự bật/tắt scroll theo hoạt động agent (MutationObserver)

### v8.2.0
- **Fix Multi-Instance** — Hỗ trợ 2+ cửa sổ cùng lúc, dynamic port, auto-discovery

### v8.1.0
- **Log Click Stats** — Ghi log chi tiết mỗi lần auto-click, hiển thị lịch sử click realtime trong Settings

### v7.4.0
- **Hỗ trợ nút Accept** — Tự động click Accept ở khung chat, tuyệt đối không click ở diff editor
- **Smart Accept Logic** — Phân biệt Accept (chat) vs Accept Changes/Accept All (editor) bằng DOM context
- **Chat-only Commands** — Commands API chỉ chạy `acceptAgentStep` (chat), không chạy `agentAcceptAllInFile` (editor)
- **Clean Injection** — Bỏ inject code vào workbench.js, chỉ dùng HTML script tag — ổn định hơn, không bị V8 cache

### v7.0.0
- **Fix 'Corrupt Installation' Warning** — Tự động cập nhật checksums trong `product.json`
- **Auto-Reload sau Update** — Tự reload sau khi cập nhật checksums
- **Auto-Dismiss Notification** — Tự đóng notification "corrupt" nếu vẫn xuất hiện

### v6.3.0
- **Click Stats Dashboard** — Thống kê click realtime, progress bar, vương miện, badge
- **Native Dialog Auto-Click** — Tự nhấn "Keep Waiting" qua Win32 API
- **Persistent Stats** — Lưu thống kê qua restart
- **Toggle Panel** — Click status bar để mở/đóng Settings
- **Display Name Mapping** — Hiển thị tên đầy đủ cho patterns

### v5.8.0
- **SSH Remote Support** — Hoạt động trên Remote-SSH
- **Async HTTP Polling** — Không block UI
- **Auto-stop polling** — Dừng sau 5 lỗi liên tiếp

### v5.5.0
- **Auto-fix sau update** — Tự inject lại khi Antigravity update

### v5.4.0
- **Smart Auto Scroll** — Chỉ cuộn trong khung chat chính
- **Jitter-free Scrolling** — Dừng cuộn khi chạm đáy

### v5.1.0
- **Linux/macOS support** — Auto-elevation
- **Diff Protection** — Không click diff editor
- **Smart Commands Loop** — Tôn trọng pattern settings
- **Status Bar Adjacent** — 2 items liền kề

### v5.0.0
- Instant Toggle, Scroll Toggle, HTTP IPC, Dual Status Bar
- UI nâng cấp, Auto-inject + Auto-reload

### v4.x
- Auto Click, Auto Scroll, Settings UI đa ngôn ngữ, Safe Click

---

## License

