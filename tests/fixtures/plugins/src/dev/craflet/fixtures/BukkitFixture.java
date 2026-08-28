package dev.craflet.fixtures;

import org.bukkit.plugin.java.JavaPlugin;

public final class BukkitFixture extends JavaPlugin {
    private FixtureLifecycle lifecycle;

    @Override
    public void onEnable() {
        lifecycle = new FixtureLifecycle(getDataFolder().toPath());
        lifecycle.enable();
    }

    @Override
    public void onDisable() {
        if (lifecycle != null) {
            lifecycle.disable();
        }
    }
}
