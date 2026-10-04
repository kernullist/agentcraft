package dev.agentcraft.client.connections;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agentcraft.client.dev.DevBridge;
import dev.agentcraft.client.dev.Fields;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.ConnectionInfo;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;

/**
 * Connections (which LLM the lead and the workers use): the {@link ConnectionsScreen}, opened by
 * the console's {@code /connect}, and its DevBridge hooks for QA:
 * {@code dev.screen {open:"connections"}} and {@code dev.connections}.
 */
public final class ConnectionsFeature {
	private ConnectionsFeature() {
	}

	public static void init() {
		DevBridge.registerScreen("connections", mc -> new ConnectionsScreen());
		DevBridge.register("dev.connections", 10_000,
			"{press?, text?, focus?} -> connections in the model (keys masked) and the open Connections screen; press a button, type text into the focused field",
			(req, mc) -> {
				Fields f = Fields.of(req);
				String press = f.optStr("press", null);
				String type = f.optStr("text", null);
				String focus = f.optStr("focus", null);
				return DevBridge.onClient(mc, () -> {
					Screen s = mc.gui.screen();
					if (s instanceof ConnectionsScreen cs) {
						if (focus != null) {
							cs.devFocus(focus);
						}
						if (type != null) {
							cs.devType(type);
						}
						if (press != null) {
							cs.press(press);
						}
					} else if (press != null || type != null || focus != null) {
						throw new DevBridge.DevException("the Connections screen is not open (dev.screen {open:\"connections\"})");
					}
					return state(mc);
				});
			});
	}

	public static void open() {
		Minecraft mc = Minecraft.getInstance();
		mc.gui.setScreen(new ConnectionsScreen());
	}

	private static JsonObject state(Minecraft mc) {
		JsonObject o = new JsonObject();
		ForemanState st = Foreman.state();
		JsonArray list = new JsonArray();
		if (st != null) {
			for (ConnectionInfo c : st.connections().values()) {
				JsonObject j = new JsonObject();
				j.addProperty("id", c.id());
				j.addProperty("name", c.name());
				j.addProperty("provider", c.provider());
				j.addProperty("auth", c.auth().wire());
				j.addProperty("message", c.message());
				j.addProperty("secret", c.secret());
				JsonArray roles = new JsonArray();
				c.roles().forEach(roles::add);
				j.add("roles", roles);
				list.add(j);
			}
			o.addProperty("providers", st.providers().size());
			o.addProperty("secretStore", st.secretStore());
		}
		o.add("connections", list);
		o.add("screen", mc.gui.screen() instanceof ConnectionsScreen cs ? cs.devState() : null);
		return o;
	}
}
