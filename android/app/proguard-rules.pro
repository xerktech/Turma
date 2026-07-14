# kotlinx.serialization keeps generated serializers via the compiler plugin;
# the default rules from the AGP + serialization plugins cover the rest.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class com.xerktech.turma.model.** {
    *** Companion;
}
-keepclasseswithmembers class com.xerktech.turma.model.** {
    kotlinx.serialization.KSerializer serializer(...);
}
