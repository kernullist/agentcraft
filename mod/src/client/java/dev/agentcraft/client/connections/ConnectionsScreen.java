package dev.agentcraft.client.connections;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.console.TextFieldView;
import dev.agentcraft.client.console.TextKeys;
import dev.agentcraft.client.console.TextModel;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Ack;
import dev.agentcraft.client.foreman.Protocol.AuthStatus;
import dev.agentcraft.client.foreman.Protocol.ConnectionField;
import dev.agentcraft.client.foreman.Protocol.ConnectionInfo;
import dev.agentcraft.client.foreman.Protocol.ProviderInfo;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * Connections: which LLM the lead and the workers use (console {@code /connect}, the auth banner,
 * {@code dev.screen {open:"connections"}}). The list shows every connection with its status (the
 * ChatGPT device code appears here), who uses it, and Lead / Workers / Both / Test / Edit / Remove.
 * "Add connection" opens a form built from the provider's fields; Save sends it to the Foreman,
 * which tests it right away. API keys are write-only: typed masked, never copied out of the field,
 * never shown again (the list shows "sk-…a1b2").
 */
public class ConnectionsScreen extends Screen {
	private static final int W = 380;
	private static final int ROW_H = 68;
	private static final long CONFIRM_NANOS = 5_000_000_000L;

	private enum Mode {
		LIST, FORM
	}

	private record Btn(String id, String label, int x, int y, int w, boolean primary, boolean enabled) {
		boolean hit(double mx, double my) {
			return mx >= x && mx < x + w && my >= y && my < y + 20;
		}
	}

	private record FieldBox(String key, int x, int y, int w, int h) {
		boolean hit(double mx, double my) {
			return mx >= x && mx < x + w && my >= y && my < y + h;
		}
	}

	private Mode mode = Mode.LIST;
	private final List<Btn> buttons = new ArrayList<>();
	private final List<FieldBox> boxes = new ArrayList<>();
	private int top;
	private @Nullable String feedback;
	private boolean feedbackError;
	private boolean busy;
	private @Nullable String confirmRemove;
	private long confirmUntil;

	// form
	private @Nullable String editId;
	private @Nullable String providerId;
	private final Map<String, TextModel> fields = new LinkedHashMap<>();
	private final Map<String, TextFieldView> views = new LinkedHashMap<>();
	private final Map<String, String> choices = new LinkedHashMap<>();
	private @Nullable String focus;

	public ConnectionsScreen() {
		super(Component.literal("Connections"));
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public boolean isInputCaptured() {
		return mode == Mode.FORM;
	}

	@Override
	protected void init() {
		minecraft.onTextInputFocusChange(this, true);
	}

	@Override
	public void removed() {
		minecraft.onTextInputFocusChange(this, false);
		// a typed key must not linger in memory longer than the screen
		fields.values().forEach(TextModel::clear);
		super.removed();
	}

	// ------------------------------------------------------------------ state

	private static List<ConnectionInfo> connections() {
		ForemanState s = Foreman.state();
		return s == null ? List.of() : List.copyOf(s.connections().values());
	}

	private static @Nullable ProviderInfo provider(@Nullable String id) {
		ForemanState s = Foreman.state();
		if (s == null || id == null) {
			return null;
		}
		for (ProviderInfo p : s.providers()) {
			if (p.id().equals(id)) {
				return p;
			}
		}
		return null;
	}

	private static @Nullable ConnectionInfo connection(@Nullable String id) {
		ForemanState s = Foreman.state();
		return s == null || id == null ? null : s.connections().get(id);
	}

	private static boolean envOnly() {
		ForemanState s = Foreman.state();
		return s != null && "env-only".equals(s.secretStore());
	}

	static String family(AuthStatus a) {
		return switch (a) {
			case OK -> "done";
			case FAILED -> "error";
			case CHECKING -> "waiting";
			default -> "idle";
		};
	}

	// ------------------------------------------------------------------ render

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		extractTransparentBackground(g);
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float partial) {
		super.extractRenderState(g, mouseX, mouseY, partial);
		buttons.clear();
		boxes.clear();
		if (mode == Mode.FORM) {
			renderForm(g, mouseX, mouseY);
		} else {
			renderList(g, mouseX, mouseY);
		}
	}

	private int ink() {
		return UiStyle.color("paper.text", 0xFF1F1E1D);
	}

	private int muted() {
		return UiStyle.color("paper.muted", 0xFF655E55);
	}

	private int error() {
		return UiStyle.color("paper.del_fg", 0xFF873C2A);
	}

	private void renderList(GuiGraphicsExtractor g, int mouseX, int mouseY) {
		Kit.Padding pad = Kit.padding("panel_paper");
		int inner = W - pad.left() - pad.right();
		List<ConnectionInfo> list = connections();
		int maxRows = Math.max(1, (height - 120) / ROW_H);
		top = Math.max(0, Math.min(top, Math.max(0, list.size() - maxRows)));
		int rows = Math.min(list.size(), maxRows);
		int h = pad.top() + 16 + 14 + Math.max(rows, 1) * ROW_H + 26 + 14 + pad.bottom();
		int px = (width - W) / 2;
		int py = Math.max(8, (height - h) / 2);
		Panels.panel(g, px, py, W, h);
		int x = px + pad.left();
		int y = py + pad.top();
		Panels.header(g, font, "Connections", x, y, inner);
		y += 16;
		ConnectionInfo lead = null;
		ConnectionInfo workers = null;
		for (ConnectionInfo c : list) {
			if (c.hasRole("lead")) {
				lead = c;
			}
			if (c.hasRole("workers")) {
				workers = c;
			}
		}
		String who = list.isEmpty() ? "" : "Marlow: " + (lead == null ? "?" : lead.name()) + "   Workers: " + (workers == null ? "?" : workers.name());
		Panels.text(g, font, TextUtil.ellipsize(font, who, inner), x, y, muted());
		y += 14;
		if (list.isEmpty()) {
			String why = Foreman.connected() ? "This Foreman runs the sim backend: connections need --backend claude or codex." : "Waiting for the Foreman.";
			for (var l : TextUtil.wrap(font, why, inner)) {
				g.text(font, l, x, y, muted(), false);
				y += 10;
			}
			y = py + pad.top() + 30 + ROW_H;
		} else {
			if (top > 0) {
				Panels.text(g, font, "▲ " + top + " more", x + inner - 50, y - 12, muted());
			}
			for (int i = top; i < top + rows; i++) {
				renderRow(g, list.get(i), x, y, inner, mouseX, mouseY);
				y += ROW_H;
			}
			if (top + rows < list.size()) {
				Panels.text(g, font, "▼ " + (list.size() - top - rows) + " more", x + inner - 50, y - 10, muted());
			}
		}
		y += 4;
		addButton(g, "add", "Add connection", x, y, 110, true, Foreman.connected() && !busy && !list.isEmpty(), mouseX, mouseY);
		addButton(g, "close", "Close", x + inner - 60, y, 60, false, true, mouseX, mouseY);
		y += 24;
		renderFeedback(g, x, y, inner);
	}

	private void renderRow(GuiGraphicsExtractor g, ConnectionInfo c, int x, int y, int inner, int mouseX, int mouseY) {
		Panels.dot(g, family(c.auth()), x, y + 1, false);
		Panels.text(g, font, c.name(), x + 10, y, ink());
		int nx = x + 10 + font.width(c.name()) + 6;
		String kind = (c.providerLabel().equals(c.name()) ? "" : c.providerLabel()) + (c.editable() ? "" : " · command line");
		Panels.text(g, font, TextUtil.ellipsize(font, kind, Math.max(20, inner - (nx - x) - 110)), nx, y, muted());
		int rx = x + inner;
		for (String role : List.of("workers", "lead")) {
			if (c.hasRole(role)) {
				String label = role.equals("lead") ? "LEAD" : "WORKERS";
				rx -= font.width(label) + 10;
				Panels.pill(g, font, label, rx, y - 1, UiStyle.color("paper.text", 0xFF1F1E1D));
				rx -= 2;
			}
		}
		y += 11;
		String models = "";
		if (c.models() != null) {
			models = "lead " + (c.models().lead() == null ? "default" : c.models().lead()) + " · workers " + (c.models().worker() == null ? "default" : c.models().worker());
		}
		String key = c.secret() == null ? "" : (models.isEmpty() ? "" : "   ") + "key " + c.secret();
		String detail = models + key;
		Panels.text(g, font, TextUtil.ellipsize(font, detail.isEmpty() ? c.dataDestination() : detail, inner - 10), x + 10, y, muted());
		y += 11;
		String msg = c.message() == null ? c.auth().wire() : c.message();
		boolean code = c.auth() == AuthStatus.CHECKING && msg.startsWith("Sign in");
		int color = c.auth() == AuthStatus.FAILED ? error() : code ? UiStyle.color("paper.path", 0xFF6C5415) : muted();
		// two lines: room for a failure reason or the device code with its URL
		List<String> lines = TextUtil.wrapPlain(font, msg, inner - 10);
		for (int i = 0; i < Math.min(2, lines.size()); i++) {
			String l = i == 1 && lines.size() > 2 ? TextUtil.ellipsize(font, l2(lines), inner - 10) : lines.get(i);
			Panels.text(g, font, l, x + 10, y, color);
			y += 10;
		}
		y += Math.max(0, 2 - lines.size()) * 10 + 2;
		int bx = x + 10;
		boolean on = Foreman.connected() && !busy;
		bx = rowButton(g, "lead:" + c.id(), "Lead", bx, y, 42, on && !c.hasRole("lead"), mouseX, mouseY);
		bx = rowButton(g, "workers:" + c.id(), "Workers", bx, y, 56, on && !c.hasRole("workers"), mouseX, mouseY);
		bx = rowButton(g, "all:" + c.id(), "Both", bx, y, 42, on && !(c.hasRole("lead") && c.hasRole("workers")), mouseX, mouseY);
		bx = rowButton(g, "test:" + c.id(), code ? "New code" : "Test", bx, y, 56, on, mouseX, mouseY);
		if (c.editable()) {
			bx = rowButton(g, "edit:" + c.id(), "Edit", bx, y, 42, on, mouseX, mouseY);
			boolean confirming = c.id().equals(confirmRemove) && System.nanoTime() < confirmUntil;
			rowButton(g, "rm:" + c.id(), confirming ? "Sure?" : "Remove", bx, y, 56, on, mouseX, mouseY);
		}
	}

	/** The rest of the text from the second wrapped line on (ellipsized by the caller). */
	private static String l2(List<String> lines) {
		return String.join(" ", lines.subList(1, lines.size()));
	}

	private int rowButton(GuiGraphicsExtractor g, String id, String label, int x, int y, int w, boolean enabled, int mouseX, int mouseY) {
		addButton(g, id, label, x, y, w, false, enabled, mouseX, mouseY);
		return x + w + 4;
	}

	private void addButton(GuiGraphicsExtractor g, String id, String label, int x, int y, int w, boolean primary, boolean enabled, int mouseX,
		int mouseY) {
		Btn b = new Btn(id, label, x, y, w, primary, enabled);
		buttons.add(b);
		boolean hover = enabled && b.hit(mouseX, mouseY);
		if (primary && enabled) {
			// like TaskScreen: the clay button with the panel highlight as text colour
			Panels.sprite(g, Kit.button(true, hover ? "hover" : "normal"), x, y, w, 20);
			String l = TextUtil.ellipsize(font, label, w - 12);
			Panels.text(g, font, l, x + (w - font.width(l)) / 2, y + 6, UiStyle.color("palette.ui.panel_hi", 0xFFFFFBF4));
			return;
		}
		Panels.button(g, font, label, x, y, w, false, hover, !enabled);
	}

	private void renderFeedback(GuiGraphicsExtractor g, int x, int y, int inner) {
		String hint = mode == Mode.FORM ? "Tab next field · Enter save · Esc back" : "Esc close · changes apply from the next turn";
		String line = feedback != null ? feedback : hint;
		Panels.text(g, font, TextUtil.ellipsize(font, line, inner), x, y, feedback != null && feedbackError ? error() : muted());
	}

	private void renderForm(GuiGraphicsExtractor g, int mouseX, int mouseY) {
		Kit.Padding pad = Kit.padding("panel_paper");
		int inner = W - pad.left() - pad.right();
		ForemanState s = Foreman.state();
		List<ProviderInfo> providers = s == null ? List.of() : s.providers();
		ProviderInfo p = provider(providerId);
		ConnectionInfo editing = connection(editId);
		// measure: provider chips, info lines, fields
		int chipRows = editing == null ? (providers.size() + 2) / 3 : 0;
		List<ConnectionField> shown = p == null ? List.of() : p.fields();
		int h = pad.top() + 16 + chipRows * 24 + (p == null ? 0 : 36) + 30 + shown.size() * 30 + 26 + 14 + pad.bottom();
		int px = (width - W) / 2;
		int py = Math.max(8, (height - h) / 2);
		Panels.panel(g, px, py, W, h);
		int x = px + pad.left();
		int y = py + pad.top();
		Panels.header(g, font, editing == null ? "Add connection" : "Edit " + editing.name(), x, y, inner);
		y += 16;
		if (editing == null) {
			int cw = (inner - 8) / 3;
			for (int i = 0; i < providers.size(); i++) {
				ProviderInfo pi = providers.get(i);
				int cx = x + (i % 3) * (cw + 4);
				int cy = y + (i / 3) * 24;
				addButton(g, "provider:" + pi.id(), pi.label(), cx, cy, cw, pi.id().equals(providerId), !busy, mouseX, mouseY);
			}
			y += chipRows * 24;
		}
		if (p == null) {
			Panels.text(g, font, "Choose what to connect.", x, y, muted());
			y += 30;
		} else {
			Panels.text(g, font, TextUtil.ellipsize(font, p.summary(), inner), x, y, muted());
			y += 11;
			// where the code goes: shown before anything is saved
			Panels.text(g, font, TextUtil.ellipsize(font, "Your repository's code is sent to: " + p.dataDestination(), inner), x, y,
				UiStyle.color("paper.path", 0xFF6C5415));
			y += 11;
			Panels.text(g, font, TextUtil.ellipsize(font, p.personalUse() ? "Personal use: runs on your own subscription login." : "", inner), x, y, muted());
			y += 14;
			y = drawField(g, "name", "Name", false, editing == null ? p.label() : editing.name(), x, y, inner);
			for (ConnectionField f : shown) {
				if (f.kind().equals("choice")) {
					y = drawChoice(g, f, x, y, inner, mouseX, mouseY);
				} else {
					y = drawField(g, f.key(), f.label() + (f.required() ? " *" : ""), f.kind().equals("secret"), placeholder(f, editing), x, y, inner);
				}
			}
		}
		y += 2;
		addButton(g, "save", busy ? "Saving…" : "Save & test", x, y, 110, true, p != null && !busy && Foreman.connected(), mouseX, mouseY);
		addButton(g, "back", "Cancel", x + inner - 60, y, 60, false, !busy, mouseX, mouseY);
		y += 24;
		renderFeedback(g, x, y, inner);
	}

	private String placeholder(ConnectionField f, @Nullable ConnectionInfo editing) {
		if (f.kind().equals("secret")) {
			if (editing != null && editing.secret() != null) {
				return "saved (" + editing.secret() + ") - empty keeps it";
			}
			return envOnly() ? "env:NAME (no OS credential store here)" : (f.placeholder() == null ? "" : f.placeholder()) + "  or env:NAME";
		}
		if (f.kind().equals("model") && editing != null && !editing.availableModels().isEmpty()) {
			return String.join(", ", editing.availableModels());
		}
		if (f.key().equals("baseUrl") && editing != null && editing.baseUrl() != null) {
			return editing.baseUrl();
		}
		return f.placeholder() == null ? "" : f.placeholder();
	}

	private int drawField(GuiGraphicsExtractor g, String key, String label, boolean secret, String placeholder, int x, int y, int w) {
		Panels.text(g, font, label, x, y, muted());
		y += 10;
		TextModel m = fields.computeIfAbsent(key, k -> new TextModel(500));
		TextFieldView v = views.computeIfAbsent(key, k -> new TextFieldView());
		TextModel shown = m;
		if (secret && !m.value().startsWith("env:")) {
			// never draw the key itself: one dot per character, caret in the same place
			shown = new TextModel(500);
			shown.set("•".repeat(m.length()));
			shown.moveTo(m.cursor(), false);
		}
		TextFieldView.Style st = new TextFieldView.Style(null, 0, placeholder, null, null, 0, 1);
		int fh = v.draw(g, font, shown, x, y, w, key.equals(focus), st);
		boxes.add(new FieldBox(key, x, y, w, fh));
		return y + fh + 2;
	}

	private int drawChoice(GuiGraphicsExtractor g, ConnectionField f, int x, int y, int w, int mouseX, int mouseY) {
		Panels.text(g, font, f.label(), x, y, muted());
		y += 10;
		String cur = choices.getOrDefault(f.key(), "");
		List<String> opts = new ArrayList<>();
		opts.add("");
		opts.addAll(f.choices());
		int cw = Math.max(36, Math.min(60, (w - 4 * (opts.size() - 1)) / opts.size()));
		int cx = x;
		for (String o : opts) {
			addButton(g, "choice:" + f.key() + ":" + o, o.isEmpty() ? "default" : o, cx, y, cw, o.equals(cur), !busy, mouseX, mouseY);
			cx += cw + 4;
		}
		return y + 22;
	}

	// ------------------------------------------------------------------ input

	@Override
	public boolean mouseClicked(MouseButtonEvent event, boolean doubleClick) {
		if (event.button() == 0) {
			for (Btn b : List.copyOf(buttons)) {
				if (b.enabled() && b.hit(event.x(), event.y())) {
					press(b.id());
					return true;
				}
			}
			for (FieldBox f : List.copyOf(boxes)) {
				if (f.hit(event.x(), event.y())) {
					focus = f.key();
					return true;
				}
			}
		}
		return super.mouseClicked(event, doubleClick);
	}

	@Override
	public boolean mouseScrolled(double mx, double my, double dx, double dy) {
		if (mode == Mode.LIST) {
			top = Math.max(0, top - (int) Math.signum(dy));
			return true;
		}
		return super.mouseScrolled(mx, my, dx, dy);
	}

	@Override
	public boolean keyPressed(KeyEvent event) {
		if (mode == Mode.LIST) {
			if (event.isEscape()) {
				onClose();
				return true;
			}
			return super.keyPressed(event);
		}
		if (event.isEscape()) {
			press("back");
			return true;
		}
		if (event.isConfirmation()) {
			press("save");
			return true;
		}
		if (event.key() == InputConstants.KEY_TAB) {
			cycleFocus(event.hasShiftDown() ? -1 : 1);
			return true;
		}
		TextModel m = focus == null ? null : fields.get(focus);
		if (m == null) {
			return true;
		}
		// a key never leaves the field through the clipboard
		boolean secret = isSecret(focus);
		if (secret && (event.isCopy() || event.isCut() || event.hasControlDown() && (event.key() == InputConstants.KEY_C || event.key() == InputConstants.KEY_X))) {
			return true;
		}
		TextKeys.handle(event, m);
		return true;
	}

	@Override
	public boolean charTyped(CharacterEvent event) {
		if (mode != Mode.FORM || focus == null) {
			return false;
		}
		int cp = event.codepoint();
		if (cp < 32) {
			return true;
		}
		TextModel m = fields.get(focus);
		if (m != null) {
			m.insert(event.codepointAsString());
		}
		return true;
	}

	private boolean isSecret(@Nullable String key) {
		ProviderInfo p = provider(providerId);
		if (p == null || key == null) {
			return false;
		}
		for (ConnectionField f : p.fields()) {
			if (f.key().equals(key)) {
				return f.kind().equals("secret");
			}
		}
		return false;
	}

	private List<String> textKeys() {
		List<String> keys = new ArrayList<>();
		keys.add("name");
		ProviderInfo p = provider(providerId);
		if (p != null) {
			for (ConnectionField f : p.fields()) {
				if (!f.kind().equals("choice")) {
					keys.add(f.key());
				}
			}
		}
		return keys;
	}

	private void cycleFocus(int dir) {
		List<String> keys = textKeys();
		int i = focus == null ? -1 : keys.indexOf(focus);
		focus = keys.get(Math.floorMod(i + dir, keys.size()));
	}

	/** Press a button by id (also used by dev.connections): add close back save provider:&lt;id&gt; lead:&lt;id&gt; ... */
	public void press(String id) {
		int colon = id.indexOf(':');
		String verb = colon < 0 ? id : id.substring(0, colon);
		String arg = colon < 0 ? "" : id.substring(colon + 1);
		switch (verb) {
			case "close" -> onClose();
			case "add" -> openForm(null);
			case "back" -> {
				mode = Mode.LIST;
				fields.values().forEach(TextModel::clear);
				feedback = null;
			}
			case "provider" -> {
				providerId = arg;
				choices.clear();
				fields.values().forEach(TextModel::clear);
				focus = textKeys().size() > 1 ? textKeys().get(1) : "name";
			}
			case "choice" -> {
				int c2 = arg.indexOf(':');
				if (c2 > 0) {
					choices.put(arg.substring(0, c2), arg.substring(c2 + 1));
				}
			}
			case "save" -> save();
			case "edit" -> openForm(arg);
			case "lead", "workers", "all" -> run(Foreman.assignConnection(arg, verb), ack -> {
				ConnectionInfo c = connection(arg);
				return (c == null ? arg : c.name()) + " now runs " + (verb.equals("all") ? "the whole team" : verb.equals("lead") ? "Marlow" : "the workers")
					+ " (from the next turn)";
			});
			case "test" -> run(Foreman.testConnection(arg), ack -> resultMessage(ack, "Tested"));
			case "rm" -> {
				if (!arg.equals(confirmRemove) || System.nanoTime() > confirmUntil) {
					confirmRemove = arg;
					confirmUntil = System.nanoTime() + CONFIRM_NANOS;
					feedback = "Press Remove again to delete " + arg + " and its saved key";
					feedbackError = false;
				} else {
					confirmRemove = null;
					run(Foreman.deleteConnection(arg), ack -> "Removed " + arg);
				}
			}
			default -> {
			}
		}
	}

	private void openForm(@Nullable String id) {
		ConnectionInfo c = connection(id);
		mode = Mode.FORM;
		editId = c == null ? null : c.id();
		providerId = c == null ? null : c.provider();
		fields.clear();
		views.clear();
		choices.clear();
		feedback = null;
		if (c != null) {
			fields.computeIfAbsent("name", k -> new TextModel(500)).set(c.name());
			if (c.models() != null) {
				if (c.models().lead() != null) {
					fields.computeIfAbsent("leadModel", k -> new TextModel(500)).set(c.models().lead());
				}
				if (c.models().worker() != null) {
					fields.computeIfAbsent("workerModel", k -> new TextModel(500)).set(c.models().worker());
				}
			}
			if (c.effort() != null) {
				choices.put("effort", c.effort());
			}
		}
		focus = "name";
	}

	private String value(String key) {
		TextModel m = fields.get(key);
		return m == null ? "" : m.value().strip();
	}

	private void save() {
		ProviderInfo p = provider(providerId);
		if (p == null || busy) {
			return;
		}
		JsonObject c = new JsonObject();
		if (editId != null) {
			c.addProperty("id", editId);
		}
		c.addProperty("provider", p.id());
		if (!value("name").isEmpty()) {
			c.addProperty("name", value("name"));
		}
		JsonObject models = new JsonObject();
		for (ConnectionField f : p.fields()) {
			String v = f.kind().equals("choice") ? choices.getOrDefault(f.key(), "") : value(f.key());
			if (v.isEmpty()) {
				continue;
			}
			switch (f.key()) {
				case "apiKey" -> {
					if (v.startsWith("env:")) {
						c.addProperty("apiKeyEnv", v.substring(4).strip());
					} else {
						c.addProperty("apiKey", v);
					}
				}
				case "baseUrl" -> c.addProperty("baseUrl", v);
				case "leadModel" -> models.addProperty("lead", v);
				case "workerModel" -> models.addProperty("worker", v);
				case "effort" -> c.addProperty("effort", v);
				default -> {
				}
			}
		}
		if (models.size() > 0) {
			c.add("models", models);
		}
		feedback = "Saving and testing…";
		feedbackError = false;
		busy = true;
		Foreman.saveConnection(c).whenComplete((ack, err) -> {
			busy = false;
			if (err != null) {
				feedback = "Not sent: " + (err.getMessage() == null ? err.toString() : err.getMessage());
				feedbackError = true;
			} else if (!ack.ok()) {
				feedback = "Foreman: " + ack.error();
				feedbackError = true;
			} else {
				// the key is with the Foreman now: drop it here
				fields.values().forEach(TextModel::clear);
				mode = Mode.LIST;
				feedback = resultMessage(ack, "Saved");
				feedbackError = ack.result() != null && ack.result().has("connection") && "failed".equals(authOf(ack));
			}
		});
	}

	private static @Nullable String authOf(Ack ack) {
		JsonObject r = ack.result();
		if (r == null || !r.has("connection") || !r.get("connection").isJsonObject()) {
			return null;
		}
		JsonObject c = r.getAsJsonObject("connection");
		return c.has("auth") ? c.get("auth").getAsString() : null;
	}

	private static String resultMessage(Ack ack, String verb) {
		JsonObject r = ack.result();
		if (r == null || !r.has("connection") || !r.get("connection").isJsonObject()) {
			return verb;
		}
		JsonObject c = r.getAsJsonObject("connection");
		String name = c.has("name") ? c.get("name").getAsString() : "connection";
		String msg = c.has("message") ? c.get("message").getAsString() : c.has("auth") ? c.get("auth").getAsString() : "";
		return verb + " " + name + ": " + msg;
	}

	private void run(CompletableFuture<Ack> f, java.util.function.Function<Ack, String> ok) {
		busy = true;
		feedback = "Sending…";
		feedbackError = false;
		f.whenComplete((ack, err) -> {
			busy = false;
			if (err != null) {
				feedback = "Not sent: " + (err.getMessage() == null ? err.toString() : err.getMessage());
				feedbackError = true;
			} else if (!ack.ok()) {
				feedback = "Foreman: " + ack.error();
				feedbackError = true;
			} else {
				feedback = ok.apply(ack);
				feedbackError = "failed".equals(authOf(ack));
			}
		});
	}

	// ------------------------------------------------------------------ dev

	/** For dev.connections: the current mode and what the form holds (keys masked). */
	public JsonObject devState() {
		JsonObject o = new JsonObject();
		o.addProperty("mode", mode.name().toLowerCase(java.util.Locale.ROOT));
		o.addProperty("provider", providerId);
		o.addProperty("editId", editId);
		o.addProperty("focus", focus);
		o.addProperty("busy", busy);
		o.addProperty("feedback", feedback);
		JsonObject f = new JsonObject();
		for (var e : fields.entrySet()) {
			f.addProperty(e.getKey(), isSecret(e.getKey()) && !e.getValue().value().startsWith("env:") ? "•".repeat(e.getValue().length()) : e.getValue().value());
		}
		o.add("fields", f);
		return o;
	}

	/** dev.connections {type}: type into the focused field (tests drive the form without SDL). */
	public void devType(String text) {
		if (focus != null) {
			fields.computeIfAbsent(focus, k -> new TextModel(500)).insert(text);
		}
	}

	public void devFocus(String key) {
		focus = key;
	}
}
