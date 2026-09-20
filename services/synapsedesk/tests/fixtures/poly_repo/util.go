package util

import "fmt"

func Shout(s string) string {
	fmt.Println(s)
	return s
}

type Greeter struct {
	Name string
}
